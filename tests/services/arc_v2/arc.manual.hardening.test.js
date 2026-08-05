// ARC v2 — Manual entry hardening pass: SC-3 (S2 tech-eval status), SC-4
// (closed_no_award needs no contract dates), BE-6 (no zero-rate contract line),
// SC-5 (backdated dates persist on the draft and survive resume), plus a deep
// "every field round-trips" assertion. Product-level over real HTTP + Postgres.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const VENDOR = IDS.users.vendor_alpha;

const WINDOW = {
  floated_at: "2024-04-03T00:00:00Z",
  submission_start_at: "2024-04-03T00:00:00Z",
  submission_end_at: "2024-04-10T00:00:00Z",
  contract_start_at: "2024-04-15T00:00:00Z",
  contract_end_at: "2025-04-15T00:00:00Z",
  comm_finalized_at: "2024-04-12T00:00:00Z",
  generated_at: "2024-04-13T00:00:00Z",
};

describe("ARC v2 manual — hardening (SC-3/SC-4/BE-6/SC-5 + field persistence)", () => {
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
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

  async function newDraft(header, targetStage) {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { type: "product", eligibility_type: "open", ...header },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: targetStage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }
  const addItem = (id, extra = {}) => client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`)
    .send({ items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre", ...extra }] });
  const addVendor = (id) => client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({ vendors: [{ vendor_id: VENDOR }] });

  // ── SC-3 — S2 status respects technical_response_required ──
  test("SC-3: S2 with technical_response_required=true → tech_eval_in_progress", async () => {
    const id = await newDraft({ title: "S2 tech", technical_response_required: true }, "evaluation");
    await addItem(id);
    await addVendor(id);
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      floated_at: WINDOW.floated_at, submission_start_at: WINDOW.submission_start_at, submission_end_at: WINDOW.submission_end_at,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("tech_eval_in_progress");
  });

  test("SC-3: S2 with technical_response_required=false → comm_eval_in_progress", async () => {
    const id = await newDraft({ title: "S2 comm", technical_response_required: false }, "evaluation");
    await addItem(id);
    await addVendor(id);
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      floated_at: WINDOW.floated_at, submission_start_at: WINDOW.submission_start_at, submission_end_at: WINDOW.submission_end_at,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("comm_eval_in_progress");
  });

  // ── SC-4 — closed_no_award must NOT require the contract/award date chain ──
  test("SC-4: closed_no_award finalizes with only created_at (no window/contract dates)", async () => {
    const id = await newDraft({ title: "no award" }, "ended");
    // No items, no vendors, no window/contract dates — only header+scope+reason.
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ended_sub_status: "closed_no_award", closed_reason: "no compliant bid", was_awarded: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("closed_no_award");
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  // ── BE-6 — an awarded line with a zero/NULL rate must be rejected ──
  test("BE-6: awarding a zero-rate quote line is rejected (no fabricated ₹0 contract line)", async () => {
    const id = await newDraft({ title: "zero rate" }, "sig_pending");
    await addItem(id);
    await addVendor(id);
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR, submitted_at: "2024-04-08T00:00:00Z", lines: [{ arc_item_id: item.id, rate: 0, gst_pct: 5 }] }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/awards`).send({
      awards: [{ arc_item_id: item.id, awarded_vendor_id: VENDOR, allocated_qty: 500 }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/approvals`).send({
      committee_decision: "approved", committee_decided_at: "2024-04-12T00:00:00Z", committee_decided_by: BUYER,
    });
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ ...WINDOW });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rate must be greater than 0/i);
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  // ── SC-5 — backdated dates persist on the draft and come back on resume ──
  test("SC-5: provenance backdated_dates persist and hydrate restores them", async () => {
    const id = await newDraft({ title: "resume dates" }, "active");
    const backdated = {
      created_at: "2024-04-02T00:00:00Z",
      floated_at: "2024-04-03T00:00:00Z",
      submission_start_at: "2024-04-03T00:00:00Z",
      submission_end_at: "2024-04-10T00:00:00Z",
      contract_start_at: "2024-04-15T00:00:00Z",
      contract_end_at: "2025-04-15T00:00:00Z",
      comm_finalized_at: "2024-04-12T00:00:00Z",
      generated_at: "2024-04-13T00:00:00Z",
      signed_by_vendor_at: "2024-04-18T00:00:00Z",
    };
    const put = await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/provenance`).send({
      target_stage: "active", backdated_dates: backdated, created_at: backdated.created_at,
    });
    expect(put.status).toBe(200);
    const got = await client.get(`/api/v1/arc-v2/manual/draft/${id}`);
    expect(got.status).toBe(200);
    const bd = got.body.data.manual_entry.backdated_dates;
    expect(bd.floated_at).toBe(backdated.floated_at);
    expect(bd.contract_end_at).toBe(backdated.contract_end_at);
    expect(bd.signed_by_vendor_at).toBe(backdated.signed_by_vendor_at);
    // created_at edit is reflected on the ARC itself (authoritative).
    expect(new Date(got.body.data.arc.created_at).getUTCDate()).toBe(2);
  });

  // ── Field persistence — every entered field round-trips, contract rate is real ──
  test("field persistence: a fully-populated S4 round-trips and the contract line carries the real rate", async () => {
    const id = await newDraft(
      { title: "Veg supplies FY24", description: "Annual vegetable supply", sample_required: true }, "active");
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "kg", spec_text: "Grade A", target_price: 28, hsn: "0702" }],
    });
    await addVendor(id);
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR, submitted_at: "2024-04-08T00:00:00Z", payment_terms: "Net 30", gstin_used: "22AAAAA0000A1Z5",
        lines: [{ arc_item_id: item.id, rate: 27.5, gst_pct: 5, lead_time_days: 2, moq: 50 }] }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/awards`).send({
      awards: [{ arc_item_id: item.id, awarded_vendor_id: VENDOR, allocated_qty: 500 }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/terms`).send({
      payment_terms_expected: "Net 30", delivery_expected: "Within 21 days", penalty_clause: "1% per week late",
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/approvals`).send({
      committee_decision: "approved", committee_decided_at: "2024-04-12T00:00:00Z", committee_decided_by: BUYER, committee_comment: "L1 awarded",
    });

    // Resume graph carries every entered field.
    const g = (await client.get(`/api/v1/arc-v2/manual/draft/${id}`)).body.data;
    expect(g.items[0].spec_text).toBe("Grade A");
    expect(Number(g.items[0].target_price)).toBe(28);
    expect(g.items[0].uom).toBe("kg");
    expect(g.items[0].hsn).toBe("0702");
    expect(Number(g.quotes[0].lines[0].rate)).toBe(27.5);
    expect(Number(g.quotes[0].lines[0].gst_pct)).toBe(5);
    expect(Number(g.quotes[0].lines[0].lead_time_days)).toBe(2);
    expect(Number(g.quotes[0].lines[0].moq)).toBe(50);
    expect(g.quotes[0].payment_terms).toBe("Net 30");
    expect(g.quotes[0].gstin_used).toBe("22AAAAA0000A1Z5");
    expect(g.arc.payment_terms_expected).toBe("Net 30");
    expect(g.arc.penalty_clause).toBe("1% per week late");
    expect(g.manual_entry.committee_comment).toBe("L1 awarded");

    // Finalize and confirm the contract line carries the real money values (not 0).
    const up = await client.post(`/api/v1/arc-v2/manual/draft/${id}/contract/${VENDOR}/document`)
      .attach("file", Buffer.from("%PDF-1.4 signed"), { filename: "s.pdf", contentType: "application/pdf" });
    expect(up.status).toBe(200);
    const fin = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ ...WINDOW, signed_by_vendor_at: "2024-04-18T00:00:00Z" });
    expect(fin.status).toBe(200);
    const line = await db.one(
      `SELECT cl.* FROM tbl_arc_contract_line cl JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id WHERE c.arc_id = $1`, [id]);
    expect(Number(line.unit_rate)).toBe(27.5);
    expect(Number(line.gst_pct)).toBe(5);
    expect(Number(line.committed_qty)).toBe(500);
  });
});
