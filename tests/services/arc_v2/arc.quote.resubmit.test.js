// ARC v2 — vendor quote RE-SUBMISSION + version history (audit trail).
//
// A vendor may update their commercial quote any number of times while the
// submission window is open. submitQuote overwrites the LIVE quote in place,
// but every submission is archived into tbl_arc_quote_version so the history is
// a COMPLETE record. This suite asserts the observable end-to-end behaviour:
//
//   1. Re-submit with a changed price → a new version is archived AND the live
//      quote reflects the new price.
//   2. GET /vendor/quote/:arcId/history returns versions newest-first and is
//      vendor-isolated (another vendor only ever sees THEIR OWN versions).
//   3. After the window closes, a re-submit is rejected by the existing
//      submissionWindowGate (control — the archive path adds no new escape).
//
// Product-level: real Express app + Postgres. No mocks. Everything is observed
// THROUGH the vendor HTTP API (history + request-detail endpoints) rather than
// direct DB reads — submitQuote flushes its response inside the db.tx, so a
// subsequent HTTP round-trip (briefly polled) is the reliable way to observe
// the committed state. alpha + beta are both invited (active BEVERAGES subs);
// they submit on the SAME ARC so the isolation assertion is meaningful.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedAutoApproveArcPolicy, cleanupArcPublishPolicy } from "../../helpers/arcPublishPolicy.js";

describe("ARC v2 — vendor quote re-submission + version history", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const HC    = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const PUBLISH_POLICY_ID = 64931; // auto-approve ARC policy so publish floats

  let buyerClient, alpha, beta;
  let arcId, itemId;             // shared re-submit / history / isolation ARC
  let closedArcId, closedItemId; // window-closed control ARC
  const createdArcIds = [];

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
    const iid = Number(res.body.data.items[0].id);
    createdArcIds.push(id);
    const pub = await buyerClient.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    return { id, itemId: iid };
  }

  // Poll a read fn through the API until a predicate holds (the submit response
  // is flushed inside the tx, so the commit can land a beat after the response).
  async function poll(fn, pred, { tries = 15, gap = 40 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await fn();
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, gap));
    }
    return last;
  }

  // Observe THROUGH the vendor HTTP API (never a direct DB read-after-commit).
  const getVersions = (client, aId) =>
    client.get(`/api/v1/arc-v2/vendor/quote/${aId}/history`).then((r) => {
      expect(r.status).toBe(200);
      return r.body.data.versions;
    });
  const getLiveRate = (client, aId, iId) =>
    client.get(`/api/v1/arc-v2/vendor/requests/${aId}`).then((r) => {
      expect(r.status).toBe(200);
      const line = (r.body.data.lines || []).find((l) => Number(l.arc_item_id) === Number(iId));
      return line ? Number(line.rate) : null;
    });

  async function draftAndSubmit(client, aId, iId, rate) {
    const draft = await client.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: aId, lines: [{ arc_item_id: iId, rate, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);
    return client.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: aId });
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
      [[IDS.users.vendor_alpha, IDS.users.vendor_beta]]
    );
    buyerClient = await httpClient(BUYER);
    alpha = await httpClient(IDS.users.vendor_alpha);
    beta  = await httpClient(IDS.users.vendor_beta);

    await seedAutoApproveArcPolicy({
      policyId: PUBLISH_POLICY_ID, hospitalityCompanyId: HC, hotelId: HOTEL,
      departmentId: null, processId: null, createdBy: BUYER, approver: BUYER,
    });

    ({ id: arcId, itemId } = await createAndPublish({ title: "Re-submit · history" }));
    ({ id: closedArcId, itemId: closedItemId } = await createAndPublish({ title: "Re-submit · window closed" }));
  });

  afterAll(async () => {
    await cleanupArcPublishPolicy({ policyId: PUBLISH_POLICY_ID, arcIds: createdArcIds });
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_quote_version WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
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

  test("alpha submits an initial quote → version 1 is archived", async () => {
    const submit = await draftAndSubmit(alpha, arcId, itemId, 100);
    expect(submit.status).toBe(200);
    expect(submit.body.data.quote.submitted_at).toBeTruthy();

    const versions = await poll(() => getVersions(alpha, arcId), (v) => v.length === 1);
    expect(versions.length).toBe(1);
    expect(versions[0].version_no).toBe(1);
    expect(await getLiveRate(alpha, arcId, itemId)).toBe(100);
  });

  test("re-submit with a changed price → a NEW version is archived and the live quote updates", async () => {
    const submit = await draftAndSubmit(alpha, arcId, itemId, 90);
    expect(submit.status).toBe(200);

    // A second version exists, and the live quote line now reflects 90.
    const versions = await poll(() => getVersions(alpha, arcId), (v) => v.length === 2);
    expect(versions.length).toBe(2);
    expect(await poll(() => getLiveRate(alpha, arcId, itemId), (r) => r === 90)).toBe(90);
  });

  test("history — GET /quote/:arcId/history returns alpha's versions newest-first", async () => {
    const versions = await getVersions(alpha, arcId);
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBe(2);
    // Newest-first: version_no 2 then 1.
    expect(versions.map((v) => v.version_no)).toEqual([2, 1]);
    expect(versions[0].grand_total).toBeGreaterThan(0);
    expect(versions[0].line_count).toBe(1);
    // The two submissions carried different prices → different grand totals.
    expect(versions[0].grand_total).not.toBe(versions[1].grand_total);
  });

  test("isolation — beta submits once and sees ONLY their own version, never alpha's", async () => {
    const submit = await draftAndSubmit(beta, arcId, itemId, 200);
    expect(submit.status).toBe(200);

    // beta's history: exactly ONE version (their own v1) — NOT alpha's two.
    const betaVersions = await poll(() => getVersions(beta, arcId), (v) => v.length === 1);
    expect(betaVersions.length).toBe(1);
    expect(betaVersions[0].version_no).toBe(1);

    // alpha's history is unchanged (still two) — no leakage in either direction.
    const alphaVersions = await getVersions(alpha, arcId);
    expect(alphaVersions.length).toBe(2);
  });

  test("window closed — a re-submit is rejected by the existing window gate (no new version)", async () => {
    // Submit once while the window is open.
    const first = await draftAndSubmit(alpha, closedArcId, closedItemId, 150);
    expect(first.status).toBe(200);
    const before = await poll(() => getVersions(alpha, closedArcId), (v) => v.length === 1);
    expect(before.length).toBe(1);

    // Backdate the submission window so the deadline has passed.
    await db.none(
      `UPDATE tbl_arc SET submission_end_at = $2 WHERE id = $1`,
      [closedArcId, new Date(Date.now() - 1 * 86400_000).toISOString()]
    );

    // Re-submit is now blocked by submissionWindowGate — and nothing is archived.
    const blocked = await alpha.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: closedArcId });
    expect(blocked.status).toBe(409);
    const after = await getVersions(alpha, closedArcId);
    expect(after.length).toBe(1);
  });
});
