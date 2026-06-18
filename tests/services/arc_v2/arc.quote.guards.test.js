// ARC v2 — vendor quote endpoint guards + validation (audit H1 / H2 / H3).
//
//   H1 — only INVITED vendors may quote; SUBMIT additionally requires an ACTIVE
//        subscription (lapsed vendors can draft but not send — agreed rule).
//   H2 — the submission deadline is enforced on draft-save too (not just submit).
//   H3 — a quote must have ≥1 line and every rate must be a non-negative number.
//
// Eligible/tagged for BEVERAGES open ARC: alpha (active), beta (active),
// gamma (expired). Not tagged: epsilon (pending, other category).
//
// Product-level: real Express app + Postgres. No mocks.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 — vendor quote guards (H1 / H2 / H3)", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const PROC = IDS.processes.A_P1;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;

  let buyerClient, alpha, gamma, epsilon;
  let openArcId, openItemId; // future deadline
  let pastArcId, pastItemId; // deadline already passed
  const createdArcIds = [];

  // Always float with a VALID future submission window (publish enforces M1);
  // a "past deadline" scenario is produced by backdating after the float, which
  // mirrors reality (deadline elapses while the ARC is live).
  async function createAndPublish({ title }) {
    const today = new Date();
    const res = await buyerClient.post("/api/v1/arc-v2").send({
      title,
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      eligibility_type: "open",
      submission_start_at: new Date(today.getTime() - 2 * 86400_000).toISOString(),
      submission_end_at:   new Date(today.getTime() + 10 * 86400_000).toISOString(),
      contract_start_at:   new Date(today.getTime() + 30 * 86400_000).toISOString(),
      contract_end_at:     new Date(today.getTime() + 365 * 86400_000).toISOString(),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    const id = Number(res.body.data.arc.id);
    const itemId = Number(res.body.data.items[0].id);
    createdArcIds.push(id);
    const pub = await buyerClient.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    return { id, itemId };
  }

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[IDS.users.vendor_alpha, IDS.users.vendor_gamma, IDS.users.vendor_epsilon]]
    );
    buyerClient = await httpClient(BUYER);
    alpha   = await httpClient(IDS.users.vendor_alpha);
    gamma   = await httpClient(IDS.users.vendor_gamma);
    epsilon = await httpClient(IDS.users.vendor_epsilon);

    ({ id: openArcId, itemId: openItemId } = await createAndPublish({ title: "Quote guards · open" }));
    ({ id: pastArcId, itemId: pastItemId } = await createAndPublish({ title: "Quote guards · past deadline" }));
    // Backdate the second ARC's submission window so its deadline has passed.
    await db.none(
      `UPDATE tbl_arc SET submission_end_at = $2 WHERE id = $1`,
      [pastArcId, new Date(Date.now() - 1 * 86400_000).toISOString()]
    );
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [createdArcIds.map(String)]);
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
  });

  test("H1 — a non-invited vendor cannot save a draft quote", async () => {
    const res = await epsilon.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: openArcId,
      lines: [{ arc_item_id: openItemId, rate: 100 }],
    });
    expect(res.status).toBe(403);
  });

  test("H1 — a non-invited vendor cannot submit a quote", async () => {
    const res = await epsilon.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: openArcId });
    expect(res.status).toBe(403);
  });

  test("H1 — an invited but lapsed vendor may draft but NOT submit (active subscription required)", async () => {
    const draft = await gamma.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: openArcId,
      lines: [{ arc_item_id: openItemId, rate: 90 }],
    });
    expect(draft.status).toBe(200); // invited → drafting allowed
    const submit = await gamma.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: openArcId });
    expect(submit.status).toBe(403); // lapsed → cannot send
  });

  test("H2 — saving a draft after the submission deadline is rejected", async () => {
    const res = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: pastArcId,
      lines: [{ arc_item_id: pastItemId, rate: 100 }],
    });
    expect(res.status).toBe(409);
  });

  test("H3 — a negative rate is rejected on draft save", async () => {
    const res = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: openArcId,
      lines: [{ arc_item_id: openItemId, rate: -5 }],
    });
    expect(res.status).toBe(400);
  });

  test("H3 — submitting a quote with zero lines is rejected", async () => {
    // header-only draft (no lines)
    const draft = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({ arc_id: openArcId, lines: [] });
    expect(draft.status).toBe(200);
    const submit = await alpha.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: openArcId });
    expect(submit.status).toBe(400);
  });

  test("M8 — a draft line whose item belongs to another ARC is rejected", async () => {
    const res = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: openArcId,
      lines: [{ arc_item_id: pastItemId, rate: 100 }], // pastItemId belongs to pastArc
    });
    expect(res.status).toBe(400);
  });

  test("happy path — an invited, active vendor with a valid line can draft AND submit", async () => {
    const draft = await alpha.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: openArcId,
      lines: [{ arc_item_id: openItemId, rate: 120, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);
    const submit = await alpha.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: openArcId });
    expect(submit.status).toBe(200);
    expect(submit.body.data.quote.submitted_at).toBeTruthy();
  });
});
