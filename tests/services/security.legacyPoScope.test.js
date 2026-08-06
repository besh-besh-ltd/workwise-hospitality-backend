// SECURITY — legacy Purchase Order endpoints: cross-tenant read + write (P0).
// ----------------------------------------------------------------------------
// The legacy PO surface (`purchaseOrderController` + `purchaseOrderModel`, as
// opposed to the already-fixed `poDashboard*` pair) authorized by one of three
// broken means, or by nothing at all:
//
//   1. GET /po/initiate/:po_id      — NO acl(), NO scope check, and it MUTATES
//                                     state (draft -> pending_approval, creates
//                                     an approval instance, regenerates the PDF
//                                     and emails approvers). Any authenticated
//                                     user could drive any other tenant's PO
//                                     into approval. A cross-company write.
//   2. GET /po/:po_id               — gated via assertCanReadParentRfq, which is
//                                     skipped entirely when po.rfq_id IS NULL,
//                                     and which silently `return`s (allow) when
//                                     the parent RFQ has a NULL
//                                     hospitality_company_id
//                                     (authorizationService.js:222). 84 such
//                                     RFQs exist in production pending data
//                                     repair, so the bypass is reachable.
//   3. GET /po/rfq/:rfq_id          — purchaseOrderModel.getPOByRFQId seeded its
//                                     WHERE with `po.rfq_id = $1` and NOTHING
//                                     else: no company, hotel, department or
//                                     process predicate.
//   4. /po/:po_id/milestones|tasks  — filtered on tbl_company.id, which in
//                                     production spans 8 distinct hospitality
//                                     companies (buyer_company_id 13 ->
//                                     hospitality companies 4..11), so the gate
//                                     does not isolate legal entities at all.
//   5. The write sweep: updateGST / updateHSN / regenerate / upload-pdf /
//                                     markGRN / addSiteRepresentative /
//                                     milestone+task mutations all took an id
//                                     from the URL or body and wrote, with no
//                                     tenant predicate anywhere.
//
// The fix routes every one of them through purchaseOrderModel.assertPoAccess(),
// which resolves the PO's tenancy from its parent RFQ (or ARC, for call-offs)
// and runs the canonical 4-axis EXISTS predicate from
// authorizationService.buildScopeExistsClause — the same shape commit 92604b60
// adopted for the PO dashboard. Out-of-scope answers 404, never 403, so the
// existence of another tenant's PO is not leaked.
//
// Fixture users used here:
//   a1_proc_buyer  — role scope (company A, hotel A1, dept proc)
//   companyA_admin — role scope (company A, hotel NULL = all hotels)
//   companyB_admin — role scope (company B) — the "foreign tenant" in every case
//   vendor_alpha   — finalized vendor on the PO
//   vendor_beta    — a different vendor

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;
const FOREIGN = IDS.users.companyB_admin;
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;

let VARIANT_ID = 1;
let buyerClient, foreignClient, vendorClient, otherVendorClient;

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;

  // acl()/noAcl() branch on user_type; the shared fixtures leave it NULL.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, FOREIGN]]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
    [[VENDOR, OTHER_VENDOR]]);

  buyerClient = await httpClient(BUYER);
  foreignClient = await httpClient(FOREIGN);
  vendorClient = await httpClient(VENDOR);
  otherVendorClient = await httpClient(OTHER_VENDOR);
});

afterAll(async () => {
  await closeDb();
});

const inserted = {
  rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [],
  milestoneIds: [], taskIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.milestoneIds.length) {
    await db.none(`DELETE FROM tbl_payment_milestone WHERE id = ANY($1::int[])`, [inserted.milestoneIds]);
  }
  if (inserted.taskIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_tasks WHERE id = ANY($1::int[])`, [inserted.taskIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_payment_milestone WHERE po_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_tasks WHERE po_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_token_login_data WHERE token_type='GRN' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

let PO_NO = 8_100_000;
const nextPoNo = () => `LEGACY-PO-${++PO_NO}`;

/**
 * RFQ (+product/vendor/quote) at an explicit scope, plus a PO hanging off it.
 * `nullHospitality: true` reproduces the production data bug that makes the
 * assertCanReadParentRfq early-return reachable.
 */
async function makeScopedPo({
  hotel = IDS.hotels.A1,
  department = IDS.departments.proc,
  process = IDS.processes.A_P1,
  hospitality = IDS.hospitality.A,
  status = "approved",
  nullHospitality = false,
} = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality,
    hotel,
    department,
    process,
  });
  inserted.rfqIds.push(rfq_id);

  if (nullHospitality) {
    // Exactly the production shape: hospitality_company_id AND hotel_id wiped
    // by the old saveRfqDraft partial-save bug (84 rows still in production).
    await db.none(
      `UPDATE tbl_rfq SET hospitality_company_id = NULL, hotel_id = NULL WHERE id = $1`,
      [rfq_id]
    );
  }

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, VENDOR]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  inserted.quoteIds.push(quote.id);

  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        comment, delivery_period, quantity, variant)
     VALUES ($1, $2, $3, $4, 100, 1000, '', '7', '1', 0) RETURNING id`,
    [rfq_id, rfq_no, quote.id, VARIANT_ID]
  );

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, 1000, $7, $8, NOW(), NOW())
     RETURNING id`,
    [rfq_id, IDS.companies.A, nextPoNo(), status, [product.id], VENDOR,
     [quoteItem.id], BUYER]
  );
  inserted.poIds.push(po.id);

  const pop = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, 1000) RETURNING id`,
    [po.id, product.id, quoteItem.id]
  );
  inserted.poProductIds.push(pop.id);

  return { rfq_id, po_id: po.id };
}

// Row ids from a list response. Denied responses carry a non-array `data`
// (the scope-error payload), so normalize before mapping.
function rowIds(res) {
  const data = res?.body?.data;
  return Array.isArray(data) ? data.map((r) => r.id) : [];
}

async function poStatus(poId) {
  const row = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
  return row.status;
}

// ===========================================================================
// 1. GET /po/:po_id — PO detail
// ===========================================================================
describe("SECURITY: GET /po/:po_id is tenant-scoped", () => {
  it("a company-B user gets 404 (not 403) on a company-A PO", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.get(`/api/v1/po/${po_id}`);
    expect(res.status).toBe(404);
  });

  it("the in-scope buyer still reads the PO", async () => {
    const { po_id } = await makeScopedPo();
    const res = await buyerClient.get(`/api/v1/po/${po_id}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.id).toBe(po_id);
  });

  it("a PO whose RFQ has a NULL hospitality_company_id is NOT readable by an arbitrary user", async () => {
    // BEFORE the fix this returned 200 with the full PO payload:
    // assertCanReadParentRfq returns (allow) when hospitality_company_id is NULL.
    const { po_id } = await makeScopedPo({ nullHospitality: true });
    const res = await foreignClient.get(`/api/v1/po/${po_id}`);
    expect(res.status).toBe(404);
  });

  it("the finalized vendor reads their own PO; another vendor gets 404", async () => {
    const { po_id } = await makeScopedPo();
    const mine = await vendorClient.get(`/api/v1/po/${po_id}`);
    expect(mine.status).toBe(200);

    const theirs = await otherVendorClient.get(`/api/v1/po/${po_id}`);
    expect(theirs.status).toBe(404);
  });
});

// ===========================================================================
// 2. /po/initiate/:po_id — the cross-company WRITE
// ===========================================================================
describe("SECURITY: /po/initiate/:po_id refuses a foreign PO and changes no state", () => {
  it("a company-B user cannot initiate a company-A draft PO", async () => {
    const { po_id } = await makeScopedPo({ status: "draft" });
    expect(await poStatus(po_id)).toBe("draft");

    const res = await foreignClient.get(`/api/v1/po/initiate/${po_id}`);
    expect(res.status).toBe(404);
    // The critical assertion: NO state change.
    expect(await poStatus(po_id)).toBe("draft");
    const instance = await db.oneOrNone(
      `SELECT approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(instance.approval_instance_id).toBeNull();
  });

  it("vendors are blocked at the route layer", async () => {
    const { po_id } = await makeScopedPo({ status: "draft" });
    const res = await vendorClient.get(`/api/v1/po/initiate/${po_id}`);
    expect(res.status).toBe(403);
    expect(await poStatus(po_id)).toBe("draft");
  });

  it("the same handler is reachable over POST (state-changing verb)", async () => {
    const { po_id } = await makeScopedPo({ status: "draft" });
    // Foreign caller: the POST route must exist AND deny — a route that does
    // not exist would also 404, so pair it with the in-scope call below.
    const denied = await foreignClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(denied.status).toBe(404);
    expect(await poStatus(po_id)).toBe("draft");

    // In-scope caller over POST: the TENANT gate passes, so the response is
    // whatever comes after it — never a routing 404. It is not a 200 either:
    // a1_proc_buyer holds rfq.read/boq.read but no awarding.create, and
    // initiating is a write (see security.poInitiateWriteGate.test.js), so the
    // permission gate refuses them with a 403 that names the reason.
    const allowed = await buyerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(allowed.status).not.toBe(404);
    expect(allowed.status).toBe(403);
    expect(allowed.body?.code).toBe("PO_WRITE_PERMISSION_REQUIRED");
  });
});

// ===========================================================================
// 3. GET /po/rfq/:rfq_id — the "conditions = [po.rfq_id = $1]" leak
// ===========================================================================
describe("SECURITY: GET /po/rfq/:rfq_id is tenant-scoped", () => {
  it("a company-B user gets nothing for a company-A RFQ", async () => {
    const { rfq_id, po_id } = await makeScopedPo();
    const res = await foreignClient.get(`/api/v1/po/rfq/${rfq_id}`);
    expect(res.status).toBe(404);
    const ids = rowIds(res);
    expect(ids).not.toContain(po_id);
  });

  it("a company-B user gets nothing for an RFQ with a NULL hospitality_company_id", async () => {
    // BEFORE the fix: assertCanReadParentRfq early-returned and the model's
    // only predicate was po.rfq_id = $1 — the full PO list leaked.
    const { rfq_id, po_id } = await makeScopedPo({ nullHospitality: true });
    const res = await foreignClient.get(`/api/v1/po/rfq/${rfq_id}`);
    const ids = rowIds(res);
    expect(ids).not.toContain(po_id);
  });

  it("the in-scope buyer still sees the RFQ's POs", async () => {
    const { rfq_id, po_id } = await makeScopedPo();
    const res = await buyerClient.get(`/api/v1/po/rfq/${rfq_id}`);
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(po_id);
  });

  it("the finalized vendor still sees their own PO for the RFQ", async () => {
    // Vendors hold no tbl_user_role_scopes rows at all, so the RFQ-scope gate
    // must not be applied to them — the model already filters on
    // finalized_vendor_id. Before the fix this 403'd every vendor.
    const { rfq_id, po_id } = await makeScopedPo();
    const res = await vendorClient.get(`/api/v1/po/rfq/${rfq_id}`);
    expect(res.status).toBe(200);
    expect(rowIds(res)).toContain(po_id);
  });

  it("a different vendor sees nothing for the same RFQ", async () => {
    const { rfq_id, po_id } = await makeScopedPo();
    const res = await otherVendorClient.get(`/api/v1/po/rfq/${rfq_id}`);
    expect(rowIds(res)).not.toContain(po_id);
  });
});

// ===========================================================================
// 4. Milestones + tasks — gated on tbl_company, which spans 8 legal entities
// ===========================================================================
describe("SECURITY: PO milestones and tasks are PO-scoped, not tbl_company-scoped", () => {
  async function seedMilestone(poId, rfqId) {
    const row = await db.one(
      `INSERT INTO tbl_payment_milestone
         (rfq_id, po_id, company_id, milestone_name, due_date, created_by)
       VALUES ($1, $2, $3, 'M1', NOW() + INTERVAL '10 days', $4) RETURNING id`,
      [rfqId, poId, IDS.companies.A, BUYER]
    );
    inserted.milestoneIds.push(row.id);
    return row.id;
  }
  async function seedTask(poId, rfqId) {
    const row = await db.one(
      `INSERT INTO tbl_purchase_order_tasks
         (rfq_id, po_id, company_id, task_name, completion_date, status, created_by)
       VALUES ($1, $2, $3, 'T1', NOW() + INTERVAL '10 days', 'pending', $4) RETURNING id`,
      [rfqId, poId, IDS.companies.A, BUYER]
    );
    inserted.taskIds.push(row.id);
    return row.id;
  }

  it("a company-B user cannot list a company-A PO's milestones or tasks", async () => {
    const { po_id, rfq_id } = await makeScopedPo();
    await seedMilestone(po_id, rfq_id);
    await seedTask(po_id, rfq_id);

    const ms = await foreignClient.get(`/api/v1/po/${po_id}/milestones`);
    expect(ms.status).toBe(404);

    const ts = await foreignClient.get(`/api/v1/po/${po_id}/tasks`);
    expect(ts.status).toBe(404);
  });

  it("the in-scope buyer still lists them", async () => {
    const { po_id, rfq_id } = await makeScopedPo();
    const msId = await seedMilestone(po_id, rfq_id);
    const tId = await seedTask(po_id, rfq_id);

    const ms = await buyerClient.get(`/api/v1/po/${po_id}/milestones`);
    expect(ms.status).toBe(200);
    expect((ms.body?.data || []).map((r) => r.id)).toContain(msId);

    const ts = await buyerClient.get(`/api/v1/po/${po_id}/tasks`);
    expect(ts.status).toBe(200);
    expect((ts.body?.data || []).map((r) => r.id)).toContain(tId);
  });

  it("a company-B user cannot create a milestone or a task on a company-A PO", async () => {
    const { po_id, rfq_id } = await makeScopedPo();

    const ms = await foreignClient.post(`/api/v1/po/milestones`)
      .send({ rfq_id, po_id, milestone_name: "Injected", due_date: "2030-01-01" });
    expect([400, 403, 404]).toContain(ms.status);

    const ts = await foreignClient.post(`/api/v1/po/tasks`)
      .send({ rfq_id, po_id, task_name: "Injected", completion_date: "2030-01-01", status: "pending" });
    expect([400, 403, 404]).toContain(ts.status);

    const leftovers = await db.one(
      `SELECT (SELECT COUNT(*) FROM tbl_payment_milestone WHERE po_id = $1)::int AS m,
              (SELECT COUNT(*) FROM tbl_purchase_order_tasks WHERE po_id = $1)::int AS t`,
      [po_id]
    );
    expect(leftovers.m).toBe(0);
    expect(leftovers.t).toBe(0);
  });

  it("a company-B user cannot update or delete a company-A milestone/task by id (IDOR)", async () => {
    const { po_id, rfq_id } = await makeScopedPo();
    const msId = await seedMilestone(po_id, rfq_id);
    const tId = await seedTask(po_id, rfq_id);

    const upd = await foreignClient.put(`/api/v1/po/milestones/${msId}`)
      .send({ milestone_name: "HACKED" });
    expect([400, 403, 404]).toContain(upd.status);

    const del = await foreignClient.delete(`/api/v1/po/tasks/${tId}`);
    expect([400, 403, 404]).toContain(del.status);

    const after = await db.one(
      `SELECT (SELECT milestone_name FROM tbl_payment_milestone WHERE id = $1) AS m_name,
              (SELECT COUNT(*) FROM tbl_purchase_order_tasks WHERE id = $2)::int AS t_count`,
      [msId, tId]
    );
    expect(after.m_name).toBe("M1");
    expect(after.t_count).toBe(1);
  });
});

// ===========================================================================
// 5. Sweep — the remaining legacy write endpoints
// ===========================================================================
describe("SECURITY: legacy PO write endpoints refuse a foreign PO", () => {
  it("updateGST does not write a foreign PO's GSTIN", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.post(`/api/v1/po/updateGST/${po_id}`).send({ value: "27AAAAA0000A1Z5" });
    expect([400, 403, 404]).toContain(res.status);

    const row = await db.one(`SELECT gstin FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(row.gstin).toBeNull();
  });

  it("updateHSN does not write a foreign PO's HSN mapping", async () => {
    const { po_id, rfq_id } = await makeScopedPo();
    const rfqProductId = inserted.rfqProductIds[inserted.rfqProductIds.length - 1];
    const res = await foreignClient.post(`/api/v1/po/updateHSN/${po_id}`)
      .send({ hsn_codes: [{ rfq_item_id: rfqProductId, code: "9999" }] });
    expect([400, 403, 404]).toContain(res.status);

    const cnt = await db.one(
      `SELECT COUNT(*)::int AS c FROM tbl_purchase_order_hsn_mapping WHERE po_id = $1`, [po_id]);
    expect(cnt.c).toBe(0);
    expect(rfq_id).toBeTruthy();
  });

  it("regenerate refuses a foreign PO", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.post(`/api/v1/po/regenerate/${po_id}`).send({});
    expect([400, 403, 404]).toContain(res.status);
  });

  it("markGRN does not flip a foreign PO's status", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.post(`/api/v1/po/markGRN`)
      .send({ po_id, grn_document_url: "", remarks: "x" });
    expect([400, 403, 404]).toContain(res.status);
    expect(await poStatus(po_id)).toBe("approved");
  });

  it("addSiteRepresentative does not mint a GRN login token for a foreign PO", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.post(`/api/v1/po/addSiteRepresentative`)
      .send({ po_id, name: "Mallory", email: "mallory@evil.test", phone: "9999999999" });
    expect([400, 403, 404]).toContain(res.status);

    const cnt = await db.one(
      `SELECT COUNT(*)::int AS c FROM tbl_token_login_data WHERE token_type='GRN' AND entity_id = $1`,
      [po_id]
    );
    expect(cnt.c).toBe(0);
  });

  it("PUT /po/:po_id refuses a foreign PO", async () => {
    const { po_id } = await makeScopedPo();
    const res = await foreignClient.put(`/api/v1/po/${po_id}`)
      .send({ changes: [{ path: "terms_and_conditions", newValue: "HACKED" }] });
    expect([400, 403, 404]).toContain(res.status);

    const row = await db.one(`SELECT terms_and_conditions FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(row.terms_and_conditions).not.toBe("HACKED");
  });

  it("approve refuses a foreign PO", async () => {
    const { po_id } = await makeScopedPo({ status: "pending_approval" });
    const res = await foreignClient.post(`/api/v1/po/approve/${po_id}`).send({ decision: "approved" });
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body?.code).toBe("PO_NOT_FOUND_OR_OUT_OF_SCOPE");
    expect(await poStatus(po_id)).toBe("pending_approval");
  });

  it("an EXPLICITLY ASSIGNED approver is not blocked by the scope gate", async () => {
    // Assignment is itself a grant, and it does not always agree with the
    // assignee's RBAC scope row. Production has one live PENDING PO approval
    // whose approver's only scope row sits on a different business unit;
    // gating approve on scope alone would strand it.
    //
    // a1_eng_buyer is scoped to (company A, hotel A1, dept ENGINEERING) and the
    // PO below sits in dept PROCUREMENT, so assertPoAccess denies them — yet
    // they are the named approver and must still be able to act.
    const APPROVER = IDS.users.a1_eng_buyer;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [APPROVER]);
    const { po_id } = await makeScopedPo({ status: "pending_approval" });

    // Sanity: the scope gate really does deny this user for this PO.
    const denied = await (await httpClient(APPROVER)).get(`/api/v1/po/${po_id}`);
    expect(denied.status).toBe(404);

    const instance = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by)
       VALUES ('PO', $1, $2, 'PENDING', 1, $3, $4, NULL, $5) RETURNING id`,
      [po_id, IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, BUYER]
    );
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
      [instance.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [step.id, APPROVER]
    );
    await db.none(
      `UPDATE tbl_rfq_purchase_order SET approval_instance_id = $1 WHERE id = $2`,
      [instance.id, po_id]
    );

    try {
      // 'rejected' rather than 'approved': the approve branch regenerates the
      // PDF through Puppeteer, which is far too slow for an authorization
      // assertion. Either decision exercises the same gate.
      const res = await (await httpClient(APPROVER))
        .post(`/api/v1/po/approve/${po_id}`).send({ decision: "rejected" });
      expect(res.body?.code).not.toBe("PO_NOT_FOUND_OR_OUT_OF_SCOPE");
      expect(res.status).toBe(200);
      expect(await poStatus(po_id)).toBe("rejected");
    } finally {
      await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = $1`, [po_id]);
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instance.id]);
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id = $1`, [step.id]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = $1`, [step.id]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [instance.id]);
    }
  });
});
