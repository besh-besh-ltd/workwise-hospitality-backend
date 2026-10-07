// POST /rfq/list-view — `filters.vendor_disagreement`.
// ---------------------------------------------------------------------------
// The dashboard's "Vendor disagreements" card lists technical evaluations where
// a vendor answered a clause "I Dont Agree", but its "View all" landed on the
// plain "technical evaluating" list — every RFQ in that stage, disagreements
// or not. The list now takes the card's own rule:
//   - an RFQ qualifies when an incomplete technical evaluation on it has at
//     least one vendor response that normalises to a disagreement
//     (dashboardMetrics.DISAGREE_SQL — the widget's predicate);
//   - a completed evaluation, or only agreeing responses, does not qualify;
//   - tab counts describe the filtered set, and the count equals the widget's.
//
// Pattern B (commit + cleanup).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import {
  addProductToRfq,
  makeTechEval,
  insertVendorTechResponse,
  cleanupTechEvals,
} from "../helpers/dashboardSeed.js";

const CALLER = IDS.users.a1_proc_buyer;
const TAG = `DISAGREE-${Date.now()}`;
const inserted = [];
const seeded = {};

async function rfqWithEval(title, { response, isComplete = false }) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer, status: 1, is_published: 1, is_tender: 0,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    title: `${TAG} ${title}`,
  });
  inserted.push(rfq_id);
  // Real RFQs carry a hotel mapping; the dashboard scopes by it.
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [rfq_id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );
  const { rfq_product_id } = await addProductToRfq(db, rfq_id);
  const { clause_ids } = await makeTechEval(db, { rfq_id, rfq_product_id, isComplete, clauseCount: 1 });
  if (response) await insertVendorTechResponse(db, { clause_id: clause_ids[0], vendor_id: IDS.users.vendor_alpha, response });
  return rfq_id;
}

beforeAll(async () => {
  // Prod's stored negative, exactly as written by the vendor form.
  seeded.disagree = await rfqWithEval("vendor disagrees", { response: "I Dont Agree" });
  seeded.agree = await rfqWithEval("vendor agrees", { response: "I Agree" });
  seeded.completed = await rfqWithEval("disagreement on a completed evaluation", { response: "I Dont Agree", isComplete: true });
  seeded.noResponse = await rfqWithEval("no vendor response yet", {});
});

afterAll(async () => {
  await cleanupTechEvals(db, inserted);
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted]);
  await closeDb();
});

const list = async (body) => {
  const client = await httpClient(CALLER);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", search: TAG, limit: 100, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
};

describe("POST /rfq/list-view filters.vendor_disagreement", () => {
  it("without the filter every seeded RFQ is listed", async () => {
    const ids = (await list({})).rows.map((r) => Number(r.id));
    expect(ids).toEqual(expect.arrayContaining([seeded.disagree, seeded.agree, seeded.completed, seeded.noResponse]));
  });

  it("keeps only RFQs with an open evaluation a vendor disagreed with, and counts that set", async () => {
    const data = await list({ filters: { vendor_disagreement: true } });
    expect(data.rows.map((r) => Number(r.id))).toEqual([seeded.disagree]);
    expect(data.total).toBe(1);
    expect(data.tab_counts.all).toBe(1);
  });

  it("accepts the string form a query-string round trip produces", async () => {
    const data = await list({ filters: { vendor_disagreement: "1" } });
    expect(data.rows.map((r) => Number(r.id))).toEqual([seeded.disagree]);
  });

  it("agrees with the Vendor disagreements card for the same RFQs", async () => {
    const client = await httpClient(CALLER);
    const res = await client.get("/api/v1/dashboard-v2/tech-evals-with-disagreements").query({ hotel_ids: String(IDS.hotels.A1) });
    expect(res.status).toBe(200);
    const cardRfqs = new Set(res.body.data.items.map((i) => Number(i.rfq_id)).filter((id) => inserted.includes(id)));
    expect([...cardRfqs]).toEqual([seeded.disagree]);
  });
});
