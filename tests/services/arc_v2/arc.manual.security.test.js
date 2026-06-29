// ARC v2 — Manual entry server-side scope hardening (SEC-2/SEC-3/SEC-4):
//  - SEC-4: an unsubscribed vendor can be picked ONLY under explicit override,
//           and the override is recorded server-side (audit-authoritative).
//  - SEC-3: quotes may only come from eligible (or overridden) vendors.
//  - SEC-2: committee_decided_by must be a user WITH ACCESS to the ARC, both at
//           the approvals section and at finalize (the body-path bypass).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const VENDOR_ALPHA = IDS.users.vendor_alpha;   // active beverages → eligible
const VENDOR_DELTA = IDS.users.vendor_delta;   // cancelled → override-only
const OUT_OF_SCOPE_USER = IDS.users.vendor_beta; // a vendor → no A1 hotel access

const WINDOW = {
  floated_at: "2024-04-03T00:00:00Z",
  submission_start_at: "2024-04-03T00:00:00Z",
  submission_end_at: "2024-04-10T00:00:00Z",
  contract_start_at: "2024-04-15T00:00:00Z",
  contract_end_at: "2025-04-15T00:00:00Z",
  comm_finalized_at: "2024-04-12T00:00:00Z",
  generated_at: "2024-04-13T00:00:00Z",
};

describe("ARC v2 manual — server-side scope (SEC-2/SEC-3/SEC-4)", () => {
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id IN ($1, $2)`, [VENDOR_ALPHA, VENDOR_DELTA]);
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::int[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id IN (SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::int[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
  });

  async function newDraft(targetStage = "draft") {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: `sec ${targetStage}`, type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: targetStage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }

  // ── SEC-4 ──
  test("SEC-4: an unsubscribed vendor without override is rejected (400) and not invited", async () => {
    const id = await newDraft();
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR_DELTA }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not subscribed|override/i);
    const inv = await db.oneOrNone(`SELECT 1 FROM tbl_arc_invitation WHERE arc_id = $1`, [id]);
    expect(inv).toBeNull();
  });

  test("SEC-4: an unsubscribed vendor WITH override is allowed and flags the ARC server-side", async () => {
    const id = await newDraft();
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR_DELTA, eligibility_overridden: true }],
    });
    expect(res.status).toBe(200);
    const me = await db.one(`SELECT eligibility_overridden FROM tbl_arc_manual_entry WHERE arc_id = $1`, [id]);
    expect(me.eligibility_overridden).toBe(true);
  });

  test("SEC-4: an eligible (subscribed) vendor needs no override and is NOT flagged", async () => {
    const id = await newDraft();
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({
      vendors: [{ vendor_id: VENDOR_ALPHA }],
    });
    expect(res.status).toBe(200);
    const me = await db.one(`SELECT eligibility_overridden FROM tbl_arc_manual_entry WHERE arc_id = $1`, [id]);
    expect(me.eligibility_overridden).toBe(false);
  });

  // ── SEC-3 ──
  test("SEC-3: a quote for an unsubscribed vendor (no override) is rejected (400)", async () => {
    const id = await newDraft();
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR_DELTA, lines: [{ arc_item_id: item.id, rate: 90, gst_pct: 5 }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not subscribed/i);
  });

  // ── SEC-2 ──
  test("SEC-2: approvals section rejects an out-of-scope committee_decided_by (400)", async () => {
    const id = await newDraft();
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/approvals`).send({
      committee_decision: "approved", committee_decided_by: OUT_OF_SCOPE_USER,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/access to this ARC/i);
  });

  // Stage an awarded sig_pending with the eligible vendor, without setting the
  // committee via the approvals section (so finalize reads it from the body).
  async function stageAwardedNoCommittee() {
    const id = await newDraft("sig_pending");
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({ vendors: [{ vendor_id: VENDOR_ALPHA }] });
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR_ALPHA, submitted_at: "2024-04-08T00:00:00Z", lines: [{ arc_item_id: item.id, rate: 90, gst_pct: 5 }] }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/awards`).send({
      awards: [{ arc_item_id: item.id, awarded_vendor_id: VENDOR_ALPHA, allocated_qty: 500 }],
    });
    return id;
  }

  test("SEC-2: finalize rejects an out-of-scope committee_decided_by in the body (400)", async () => {
    const id = await stageAwardedNoCommittee();
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, committee_decision: "approved", committee_decided_by: OUT_OF_SCOPE_USER,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/access to this ARC/i);
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  test("SEC-2: finalize accepts an in-scope committee decider (the buyer)", async () => {
    const id = await stageAwardedNoCommittee();
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, committee_decision: "approved", committee_decided_by: BUYER,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("awaiting_vendor_acceptance");
  });
});
