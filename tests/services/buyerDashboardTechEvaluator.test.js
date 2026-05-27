// Wave-style integration test for the Technical Evaluator dashboard widgets.
//
// Seeds a deterministic tech-eval state at Hotel A1, hits the real HTTP
// endpoints as the tech-eval-scoped fixture user, and asserts on exact
// counts + exact tech-eval IDs.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
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
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [] };
const seeded = {};

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── A1 — 2 pending tech-evals on different RFQs ───────────────────
    const rfq1 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "RFQ for tech eval 1",
    });
    const prod1 = await addProductToRfq(t, rfq1.rfq_id);
    const te1 = await makeTechEval(t, {
      rfq_id: rfq1.rfq_id,
      rfq_product_id: prod1.rfq_product_id,
      isComplete: false,
    });

    const rfq2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "RFQ for tech eval 2",
    });
    const prod2 = await addProductToRfq(t, rfq2.rfq_id);
    const te2 = await makeTechEval(t, {
      rfq_id: rfq2.rfq_id,
      rfq_product_id: prod2.rfq_product_id,
      isComplete: false,
    });

    // ── Completed tech-eval — should NOT appear in "pending" ──────────
    const rfq3 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      status: 1,
      is_published: 1,
      title: "RFQ with completed tech eval",
    });
    const prod3 = await addProductToRfq(t, rfq3.rfq_id);
    const te3 = await makeTechEval(t, {
      rfq_id: rfq3.rfq_id,
      rfq_product_id: prod3.rfq_product_id,
      isComplete: true,
    });
    // Backfill responses on the completed eval so the throughput query
    // has data (score_timestamp lands now, opened_at was set on insert).
    await insertVendorTechResponse(t, {
      clause_id: te3.clause_ids[0],
      vendor_id: IDS.users.vendor_alpha,
      response: "agree",
    });
    // Push the eval's "opened" timestamp back so completed_at - opened_at
    // computes a meaningful avg.
    await t.none(
      `UPDATE tbl_rfq_product_tech_evaluation
       SET "timestamp" = NOW() - INTERVAL '5 hours'
       WHERE id = $1`,
      [te3.tech_eval_id]
    );

    // ── Tech-eval at Hotel A2 — must NOT appear in A1 query ───────────
    const rfqA2 = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A2,
      status: 1,
      is_published: 1,
      title: "RFQ A2 tech eval",
    });
    const prodA2 = await addProductToRfq(t, rfqA2.rfq_id);
    const teA2 = await makeTechEval(t, {
      rfq_id: rfqA2.rfq_id,
      rfq_product_id: prodA2.rfq_product_id,
      isComplete: false,
    });

    // ── Disagreements: te1 has 2 vendors disagreeing on 1 clause each
    await insertVendorTechResponse(t, {
      clause_id: te1.clause_ids[0],
      vendor_id: IDS.users.vendor_alpha,
      response: "disagree",
    });
    await insertVendorTechResponse(t, {
      clause_id: te1.clause_ids[0],
      vendor_id: IDS.users.vendor_beta,
      response: "disagree",
    });
    // te2 has 1 vendor disagreeing on 2 clauses
    await insertVendorTechResponse(t, {
      clause_id: te2.clause_ids[0],
      vendor_id: IDS.users.vendor_alpha,
      response: "disagree",
    });
    await insertVendorTechResponse(t, {
      clause_id: te2.clause_ids[1],
      vendor_id: IDS.users.vendor_alpha,
      response: "disagree",
    });
    // Plus an "agree" — must not count.
    await insertVendorTechResponse(t, {
      clause_id: te2.clause_ids[1],
      vendor_id: IDS.users.vendor_beta,
      response: "agree",
    });

    seeded.te1 = te1.tech_eval_id;
    seeded.te2 = te2.tech_eval_id;
    seeded.te3 = te3.tech_eval_id;
    seeded.teA2 = teA2.tech_eval_id;
    seeded.rfq1 = rfq1.rfq_id;
    seeded.rfq2 = rfq2.rfq_id;
    seeded.rfq3 = rfq3.rfq_id;
    seeded.rfqA2 = rfqA2.rfq_id;
    inserted.rfqIds = [rfq1.rfq_id, rfq2.rfq_id, rfq3.rfq_id, rfqA2.rfq_id];
  });
});

afterAll(async () => {
  await cleanupTechEvals(db, inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Technical Evaluator widgets (real data)", () => {
  /* ────────── /my-tech-evals-pending ───────── */

  describe("GET /dashboard-v2/my-tech-evals-pending", () => {
    it("returns exactly the 2 incomplete tech-evals at A1, oldest-first", async () => {
      const client = await httpClient(IDS.users.a1_proc_techEval);
      const res = await client
        .get("/api/v1/dashboard-v2/my-tech-evals-pending")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(2);

      const ids = res.body.data.items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([seeded.te1, seeded.te2]));
      expect(ids).not.toContain(seeded.te3);  // completed → excluded
      expect(ids).not.toContain(seeded.teA2); // wrong hotel → excluded

      // Each item carries the FE-required fields.
      for (const item of res.body.data.items) {
        expect(item).toHaveProperty("rfq_no");
        expect(item).toHaveProperty("product_name");
        expect(item).toHaveProperty("opened_at");
        expect(typeof item.rfq_id).toBe("number");
        expect(typeof item.product_id).toBe("number");
      }

      // Items are ordered ASC by opened_at — first item is the oldest.
      expect(res.body.data.oldest_opened_at).toBe(res.body.data.items[0].opened_at);
    });
  });

  /* ────────── /tech-evals-with-disagreements ───────── */

  describe("GET /dashboard-v2/tech-evals-with-disagreements", () => {
    it("returns exactly the 2 tech-evals with vendor disagreements, with accurate counts", async () => {
      const client = await httpClient(IDS.users.a1_proc_techEval);
      const res = await client
        .get("/api/v1/dashboard-v2/tech-evals-with-disagreements")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(2);

      const byId = {};
      for (const item of res.body.data.items) byId[item.id] = item;

      // te1: 2 vendors disagreeing on 1 clause
      expect(byId[seeded.te1]).toBeDefined();
      expect(byId[seeded.te1].disagreeing_vendor_count).toBe(2);
      expect(byId[seeded.te1].disagreeing_clause_count).toBe(1);

      // te2: 1 vendor disagreeing on 2 clauses
      expect(byId[seeded.te2]).toBeDefined();
      expect(byId[seeded.te2].disagreeing_vendor_count).toBe(1);
      expect(byId[seeded.te2].disagreeing_clause_count).toBe(2);

      // total_disagreement_clauses = 1 + 2 = 3
      expect(res.body.data.total_disagreement_clauses).toBe(3);

      // te3 (completed) and teA2 (wrong hotel) must not appear.
      expect(byId[seeded.te3]).toBeUndefined();
      expect(byId[seeded.teA2]).toBeUndefined();

      // Ordering: vendor count DESC — te1 (2 vendors) before te2 (1 vendor).
      expect(res.body.data.items[0].id).toBe(seeded.te1);
    });
  });

  /* ────────── /tech-eval-throughput ───────── */

  describe("GET /dashboard-v2/tech-eval-throughput", () => {
    it("returns a real avg-turnaround for completed tech-evals", async () => {
      const client = await httpClient(IDS.users.a1_proc_techEval);
      const res = await client
        .get("/api/v1/dashboard-v2/tech-eval-throughput")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.unit).toBe("hrs");
      expect(Array.isArray(res.body.data.sparkline)).toBe(true);
      expect(res.body.data.sparkline.length).toBe(4);

      // te3 is completed and opened 5 hours before the response timestamp.
      // The avg-hours value should be a positive number around 5 (a few
      // seconds of clock drift between INSERT and now() is OK — assert
      // it falls in a reasonable band).
      expect(res.body.data.current_period_avg_hours).toBeGreaterThan(4.9);
      expect(res.body.data.current_period_avg_hours).toBeLessThan(5.5);

      // The most recent sparkline cell (last index) covers "this week"
      // and should mirror current period for our single seeded eval.
      const lastBucket = res.body.data.sparkline[3];
      expect(lastBucket).toBeGreaterThan(4.9);
      expect(lastBucket).toBeLessThan(5.5);
    });

    it("returns null avg when no completed evals exist in the hotel", async () => {
      // B1 has no seeded tech-evals.
      const client = await httpClient(IDS.users.companyB_admin);
      const res = await client
        .get("/api/v1/dashboard-v2/tech-eval-throughput")
        .query({ hotel_ids: String(IDS.hotels.B1) });
      expect(res.status).toBe(200);
      expect(res.body.data.current_period_avg_hours).toBeNull();
      expect(res.body.data.prior_period_avg_hours).toBeNull();
      expect(res.body.data.delta_pct).toBeNull();
    });
  });

  /* ────────── Scope isolation ───────── */

  describe("Scope isolation", () => {
    it("Hotel B user sees zero tech-evals for our seeded A-side data", async () => {
      const client = await httpClient(IDS.users.companyB_admin);
      const [pending, disagree] = await Promise.all([
        client
          .get("/api/v1/dashboard-v2/my-tech-evals-pending")
          .query({ hotel_ids: String(IDS.hotels.B1) }),
        client
          .get("/api/v1/dashboard-v2/tech-evals-with-disagreements")
          .query({ hotel_ids: String(IDS.hotels.B1) }),
      ]);
      expect(pending.body.data.count).toBe(0);
      expect(disagree.body.data.count).toBe(0);
      expect(disagree.body.data.total_disagreement_clauses).toBe(0);
    });
  });
});
