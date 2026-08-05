// ARC v2 — Manual entry: awarded-path finalize for S3/S4/S5
// (§11 arc.manual.sig_pending, .active, .ended) + award-balance + dates.

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

describe("ARC v2 manual — awarded-path finalize (S3/S4/S5)", () => {
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

  // Build a draft staged up to awards, returning { id, itemId }.
  async function stageAwarded(targetStage, { allocated = 500 } = {}) {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: `Awarded ${targetStage}`, type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: targetStage, created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({ vendors: [{ vendor_id: VENDOR }] });
    const item = await db.one(`SELECT id FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/quotes`).send({
      quotes: [{ vendor_id: VENDOR, submitted_at: "2024-04-08T00:00:00Z", payment_terms: "Net 30",
        lines: [{ arc_item_id: item.id, rate: 90, gst_pct: 5 }] }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/awards`).send({
      awards: [{ arc_item_id: item.id, awarded_vendor_id: VENDOR, allocated_qty: allocated, l_rank: "L1", is_l1_default: true }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/approvals`).send({
      committee_decision: "approved", committee_decided_at: "2024-04-12T00:00:00Z", committee_decided_by: BUYER,
    });
    return { id, itemId: item.id };
  }

  const WINDOW = {
    floated_at: "2024-04-03T00:00:00Z",
    submission_start_at: "2024-04-03T00:00:00Z",
    submission_end_at: "2024-04-10T00:00:00Z",
    contract_start_at: "2024-04-15T00:00:00Z",
    contract_end_at: "2025-04-15T00:00:00Z",
    comm_finalized_at: "2024-04-12T00:00:00Z",
    generated_at: "2024-04-13T00:00:00Z",
  };

  test("S3 sig_pending → contract awaiting_acceptance, document NULL, ARC awaiting_vendor_acceptance", async () => {
    const { id } = await stageAwarded("sig_pending");
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ ...WINDOW });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("awaiting_vendor_acceptance");
    const contracts = await db.any(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(contracts.length).toBe(1);
    expect(contracts[0].status).toBe("awaiting_acceptance");
    expect(contracts[0].document_s3_url).toBeNull();
    // committee outcome snapshot recorded, NO live approval instance.
    const me = await db.one(`SELECT * FROM tbl_arc_manual_entry WHERE arc_id = $1`, [id]);
    expect(me.committee_decision).toBe("approved");
    const comm = await db.one(`SELECT * FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [id]);
    expect(comm.approval_instance_id).toBeNull();
  });

  test("S3 sig_pending rejects a manual document upload (409)", async () => {
    const { id } = await stageAwarded("sig_pending");
    const res = await client
      .post(`/api/v1/arc-v2/manual/draft/${id}/contract/${VENDOR}/document`)
      .attach("file", Buffer.from("%PDF-1.4 test"), { filename: "c.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(409);
  });

  test("S4 active → upload signed PDF, contract active+manual_upload, ARC contract_active, signed_by_vendor_at backdated", async () => {
    const { id } = await stageAwarded("active");
    const up = await client
      .post(`/api/v1/arc-v2/manual/draft/${id}/contract/${VENDOR}/document`)
      .attach("file", Buffer.from("%PDF-1.4 signed contract"), { filename: "signed.pdf", contentType: "application/pdf" });
    expect(up.status).toBe(200);
    expect(up.body.data.document_source).toBe("manual_upload");
    expect(up.body.data.document_hash).toMatch(/^[a-f0-9]{64}$/);

    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, signed_by_vendor_at: "2024-04-18T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("contract_active");
    const contract = await db.one(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(contract.status).toBe("active");
    expect(contract.document_source).toBe("manual_upload");
    expect(contract.document_s3_url).not.toBeNull();
    expect(new Date(contract.signed_by_vendor_at).getUTCFullYear()).toBe(2024);
    expect(new Date(contract.signed_by_vendor_at).getUTCDate()).toBe(18);
  });

  test("S4 active requires the signed PDF upload before finalize (400)", async () => {
    const { id } = await stageAwarded("active");
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, signed_by_vendor_at: "2024-04-18T00:00:00Z",
    });
    expect(res.status).toBe(400);
  });

  test("S5 ended (terminated, awarded) → ARC terminated, contract terminated, reason persisted", async () => {
    const { id } = await stageAwarded("ended");
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, ended_sub_status: "terminated", closed_reason: "vendor breach", was_awarded: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("terminated");
    const arc = await db.one(`SELECT closed_reason FROM tbl_arc WHERE id = $1`, [id]);
    expect(arc.closed_reason).toBe("vendor breach");
    const contract = await db.one(`SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(contract.status).toBe("terminated");
  });

  test("S5 ended closed_no_award → ARC closed_no_award, no contracts", async () => {
    // closed_no_award needs only header+scope+reason; build a bare draft.
    const created = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "closed no award", type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "ended", created_at: "2024-04-01T00:00:00Z" },
    });
    const id = created.body.data.arc.id;
    createdArcIds.push(id);
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/items`).send({
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre" }],
    });
    await client.put(`/api/v1/arc-v2/manual/draft/${id}/section/vendors`).send({ vendors: [{ vendor_id: VENDOR }] });
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, ended_sub_status: "closed_no_award", closed_reason: "no compliant bid", was_awarded: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.arc.status).toBe("closed_no_award");
    const c = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_contract WHERE arc_id = $1`, [id]);
    expect(c.n).toBe(0);
  });

  test("award balance: Σ allocated_qty must equal indicative_qty (4xx)", async () => {
    const { id } = await stageAwarded("sig_pending", { allocated: 400 }); // indicative is 500
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({ ...WINDOW });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/indicative/i);
  });

  test("dates: out-of-order chain rejected (submission_end before start)", async () => {
    const { id } = await stageAwarded("sig_pending");
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW,
      submission_start_at: "2024-04-10T00:00:00Z",
      submission_end_at: "2024-04-03T00:00:00Z", // before start
    });
    expect(res.status).toBe(400);
  });

  test("dates: future timestamp rejected", async () => {
    const { id } = await stageAwarded("sig_pending");
    const future = new Date(Date.now() + 365 * 86400_000).toISOString();
    const res = await client.post(`/api/v1/arc-v2/manual/draft/${id}/finalize`).send({
      ...WINDOW, floated_at: future,
    });
    expect(res.status).toBe(400);
  });
});
