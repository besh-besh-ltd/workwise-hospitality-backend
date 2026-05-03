// Wave-1 step-3.14 / 3.15 tests: vendor PO accept/reject + de-finalization
// cascade. The remaining PO flow (finalize → NEGOTIATION_QUOTE approval →
// initiate → multi-step approve → vendor accept) is broken into smaller
// focused tests below, with the deeper happy-path / multi-step approval
// pieces deferred to Task 29 (approver-acting helper).
//
// Defects locked in:
//   - F-PO-IDEM-001 (P1) — accept/reject return ambiguous error for double-
//     action OR wrong vendor OR wrong status. Documented as expected.
//   - F-PO-CASCADE-001 (P0) — `handlePORejection` deletes finalization rows
//     by (rfq_id, product_variant_id, variant), NOT by vendor_id. Multi-vendor
//     POs (rare but constructible) → rejecting Vendor A also un-finalizes
//     Vendor B's row. Test demonstrates the bug; current behaviour is
//     locked in here.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import * as poController from "../../app/controllers/po/purchaseOrderController.js";
import { makeRFQ } from "../factories/rfq.js";
import { approveFully, getInstanceState } from "../helpers/approval.js";

afterAll(async () => {
  await closeDb();
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

// We track every PO-related id we insert so afterEach scrubs it.
const inserted = {
  rfqIds: [],
  poIds: [],
  poProductIds: [],
  finalizationIds: [],
  finalizationHistoryIds: [],
  rfqProductIds: [],
  quoteIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.finalizationHistoryIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE id = ANY($1::int[])`, [inserted.finalizationHistoryIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.finalizationIds.length) {
    // Some may have been moved to history by the controller; that's fine.
    await db.none(`DELETE FROM tbl_quote_finalization WHERE id = ANY($1::int[])`, [inserted.finalizationIds]);
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

// ---- Setup helpers ---------------------------------------------------------

let PO_NO = 5_000_000;
const nextPoNo = () => `TEST-PO-${++PO_NO}`;

async function makeRfqWithProductAndVendor({ vendorId = IDS.users.vendor_alpha, productVariantId = 1 } = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, productVariantId]
  );
  inserted.rfqProductIds.push(product.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
  // A minimal quote to satisfy quote_id FK in finalization.
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, 1, $2, $2) RETURNING id`,
    [rfq_id, vendorId]
  );
  inserted.quoteIds.push(quote.id);
  return { rfq_id, rfq_product_id: product.id, product_variant_id: productVariantId, quote_id: quote.id };
}

async function makeFinalization(rfq_id, product_variant_id, vendor_id, quote_id) {
  const row = await db.one(
    `INSERT INTO tbl_quote_finalization
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, vendor_id, created_by)
     VALUES ($1, 1, $2, $3, 0, $4, $5) RETURNING id`,
    [rfq_id, quote_id, product_variant_id, vendor_id, IDS.users.a1_proc_buyer]
  );
  inserted.finalizationIds.push(row.id);
  return row.id;
}

async function makePo({
  rfq_id, vendorId = IDS.users.vendor_alpha, status = "acceptance_pending",
  rfq_product_ids = [], quote_ids = [], initiatedBy = IDS.users.a1_proc_buyer,
  companyId = IDS.companies.A, // tbl_company.id (parent), NOT tbl_hospitality_companies.id
}) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, 100, $7, $8, NOW(), NOW())
     RETURNING id`,
    [
      rfq_id,
      companyId,
      nextPoNo(),
      status,
      rfq_product_ids,
      vendorId,
      quote_ids,
      initiatedBy,
    ]
  );
  inserted.poIds.push(po.id);
  return po.id;
}

async function attachProductToPo(po_id, rfq_product_id, quote_id) {
  const r = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, 100) RETURNING id`,
    [po_id, rfq_product_id, quote_id]
  );
  inserted.poProductIds.push(r.id);
  return r.id;
}

// ===========================================================================
//  acceptPO
// ===========================================================================

describe("acceptPO — gates", () => {
  it("returns 400 when PO does not exist", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: "999999999" },
    });
    await poController.acceptPO(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/PO not found/i);
  });

  it("returns specific 'PO not in acceptance_pending state' message (not the ambiguous lump)", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor();
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "draft",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: String(po_id) },
    });
    await poController.acceptPO(m.req, m.res);
    // POST-FIX: distinct status + message per failure mode (see F-PO-IDEM-001).
    expect([400, 409]).toContain(m.calls.status);
    expect(m.calls.body.message).toMatch(/not.*acceptance|wrong.*state|invalid.*state/i);
    expect(m.calls.body.message).not.toMatch(/PO not found, already actioned, or you are not the assigned vendor/i);
  });

  it("F-PO-IDEM-001 — wrong-vendor caller gets a distinct 403/forbidden error (NOT the ambiguous lump)", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor({
      vendorId: IDS.users.vendor_alpha,
    });
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "acceptance_pending",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    const m = mockExpress({
      user: { id: IDS.users.vendor_beta }, // wrong vendor
      params: { po_id: String(po_id) },
    });
    await poController.acceptPO(m.req, m.res);
    // POST-FIX: a wrong-vendor caller is told distinctly that they are not
    // the assigned vendor — caller can distinguish this from "already actioned".
    expect([403, 400]).toContain(m.calls.status);
    expect(m.calls.body.message).toMatch(/not.*assigned.*vendor|forbidden|unauthorized/i);
    expect(m.calls.body.message).not.toMatch(/PO not found, already actioned, or you are not the assigned vendor/i);
    // Status MUST not change.
    const after = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id=$1`, [po_id]);
    expect(after.status).toBe("acceptance_pending");
  });

  it("happy path: flips status acceptance_pending → approved, sets vendor_action_at", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor({
      vendorId: IDS.users.vendor_alpha,
    });
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "acceptance_pending",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: String(po_id) },
    });
    await poController.acceptPO(m.req, m.res);

    expect(m.calls.body.status).toBe(1);
    const after = await db.one(`SELECT status, vendor_action_at FROM tbl_rfq_purchase_order WHERE id=$1`, [po_id]);
    expect(after.status).toBe("approved");
    expect(after.vendor_action_at).not.toBeNull();
  });

  it("F-PO-IDEM-001 — second accept on already-actioned PO returns 409 Conflict with a clear 'already actioned' message", async () => {
    const { rfq_id, rfq_product_id, quote_id } = await makeRfqWithProductAndVendor({
      vendorId: IDS.users.vendor_alpha,
    });
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "acceptance_pending",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    // First call succeeds.
    await poController.acceptPO(
      mockExpress({ user: { id: IDS.users.vendor_alpha }, params: { po_id: String(po_id) } }).req,
      mockExpress({}).res
    );
    // POST-FIX: second call returns 409 Conflict with a specific "already
    // accepted/actioned" message — caller can distinguish this from
    // "wrong vendor" or "PO not found".
    const m2 = mockExpress({ user: { id: IDS.users.vendor_alpha }, params: { po_id: String(po_id) } });
    await poController.acceptPO(m2.req, m2.res);
    expect(m2.calls.status).toBe(409);
    expect(m2.calls.body.message).toMatch(/already.*(actioned|accepted)/i);
    expect(m2.calls.body.message).not.toMatch(/PO not found, already actioned, or you are not the assigned vendor/i);
  });
});

// ===========================================================================
//  rejectPO
// ===========================================================================

describe("rejectPO — gates", () => {
  it("returns 400 when reason is missing/empty", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: "1" },
      body: {},
    });
    await poController.rejectPO(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Rejection reason is required/i);
  });

  it("returns 400 when reason is whitespace only", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: "1" },
      body: { reason: "   " },
    });
    await poController.rejectPO(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("returns 400 when PO does not exist", async () => {
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: "999999999" },
      body: { reason: "no thanks" },
    });
    await poController.rejectPO(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });

  it("happy path: status flips → rejected_by_vendor, reason stored, finalization moved to history", async () => {
    const { rfq_id, rfq_product_id, product_variant_id, quote_id } =
      await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_alpha });
    const finalizationId = await makeFinalization(
      rfq_id, product_variant_id, IDS.users.vendor_alpha, quote_id
    );
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "acceptance_pending",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: String(po_id) },
      body: { reason: "Quality concerns" },
    });
    await poController.rejectPO(m.req, m.res);

    expect(m.calls.body.status).toBe(1);
    const after = await db.one(
      `SELECT status, vendor_rejection_reason, vendor_action_at
       FROM tbl_rfq_purchase_order WHERE id=$1`, [po_id]
    );
    expect(after.status).toBe("rejected_by_vendor");
    expect(after.vendor_rejection_reason).toBe("Quality concerns");
    expect(after.vendor_action_at).not.toBeNull();

    // Finalization row should be removed (cascade) — its data went to history.
    const finalizationRow = await db.oneOrNone(
      `SELECT id FROM tbl_quote_finalization WHERE id=$1`, [finalizationId]
    );
    expect(finalizationRow).toBeNull();

    // History row should now exist for that vendor + product.
    const histRow = await db.one(
      `SELECT id, vendor_id, changed_by FROM tbl_quote_finalization_history
       WHERE rfq_id=$1 AND product_variant_id=$2`,
      [rfq_id, product_variant_id]
    );
    expect(histRow.vendor_id).toBe(IDS.users.vendor_alpha);
    expect(histRow.changed_by).toBe(IDS.users.vendor_alpha);
    inserted.finalizationHistoryIds.push(histRow.id);
  });

  it("F-PO-CASCADE-001 — multi-vendor PO rejection cascades only the rejecting vendor's finalizations", async () => {
    // Construct a PO that contains products with finalizations from TWO
    // different vendors. Vendor A rejects PO X → the de-finalization cascade
    // MUST scope by (rejecting_vendor_id × products-in-this-PO):
    //   - Vendor A's finalizations on PO X's products → moved to history.
    //   - Vendor B's finalizations on PO X's products → UNTOUCHED.
    //
    // Bug today: handlePORejection's cascade WHERE clause only filters by
    // (rfq_id, product_variant_id, variant) — no vendor_id filter — so
    // Vendor B's row is wiped too. Fix: add `AND vendor_id = $rejectingVendorId`.
    //
    // POST-FIX assertion below. Will fail until the fix lands.
    const { rfq_id, quote_id } = await makeRfqWithProductAndVendor({
      vendorId: IDS.users.vendor_alpha,
      productVariantId: 1,
    });
    // Add a SECOND product (variant id 2) and attach Vendor B's finalization.
    const productB = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 2, 0) RETURNING id`,
      [rfq_id]
    );
    inserted.rfqProductIds.push(productB.id);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, 2, $2, 0)`,
      [rfq_id, IDS.users.vendor_beta]
    );
    const quoteB = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
       VALUES ($1, 1, $2, $2) RETURNING id`,
      [rfq_id, IDS.users.vendor_beta]
    );
    inserted.quoteIds.push(quoteB.id);

    const finalizationA = await makeFinalization(rfq_id, 1, IDS.users.vendor_alpha, quote_id);
    const finalizationB = await makeFinalization(rfq_id, 2, IDS.users.vendor_beta, quoteB.id);

    // Get the existing rfq_product for Vendor A (variant 1) — it was created
    // by makeRfqWithProductAndVendor and we have its id in inserted.rfqProductIds[0].
    const productA_id = inserted.rfqProductIds[0];

    // Construct one PO that points to BOTH products. The finalized_vendor_id
    // is just one (whichever the controller's `acceptPO`/`rejectPO` validates
    // against), but the rfq_product_id ARRAY contains both. The cascade looks
    // at tbl_purchase_order_product — so we attach BOTH products there.
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "acceptance_pending",
      rfq_product_ids: [productA_id, productB.id], quote_ids: [quote_id, quoteB.id],
    });
    await attachProductToPo(po_id, productA_id, quote_id);
    await attachProductToPo(po_id, productB.id, quoteB.id);

    // Vendor A rejects.
    const m = mockExpress({
      user: { id: IDS.users.vendor_alpha },
      params: { po_id: String(po_id) },
      body: { reason: "Bad fit" },
    });
    await poController.rejectPO(m.req, m.res);
    expect(m.calls.body.status).toBe(1);

    // POST-FIX expectation: only Vendor A's finalization moves to history.
    // Vendor B's row stays in tbl_quote_finalization untouched.
    const a = await db.oneOrNone(`SELECT id FROM tbl_quote_finalization WHERE id=$1`, [finalizationA]);
    const b = await db.oneOrNone(`SELECT id FROM tbl_quote_finalization WHERE id=$1`, [finalizationB]);
    expect(a).toBeNull();
    expect(b).not.toBeNull();
    const hist = await db.any(
      `SELECT vendor_id FROM tbl_quote_finalization_history WHERE rfq_id=$1 ORDER BY vendor_id`,
      [rfq_id]
    );
    inserted.finalizationHistoryIds.push(...(await db.any(`SELECT id FROM tbl_quote_finalization_history WHERE rfq_id=$1`, [rfq_id])).map((r) => r.id));
    expect(hist.map((r) => r.vendor_id)).toEqual([IDS.users.vendor_alpha]);
  });
});

// ===========================================================================
//  Deferred — full PO flow (finalize → NEGOTIATION_QUOTE → initiate → multi-
//  step approve → vendor accept), 3-tier reminder cron, merge prompt
// ===========================================================================

// ===========================================================================
//  PO full flow — initiatePO → approveFully → handlePOPostApproval
//  Resolves several Task 30 todos using the new approval helper.
// ===========================================================================

describe("initiatePO — creates PO approval instance against the PO policy", () => {
  it("draft PO under A1/P1 → POST /po/initiate creates a PENDING PO approval instance against IDS.policies.A1_P1_PO", async () => {
    const { rfq_id, rfq_product_id, product_variant_id, quote_id } =
      await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_alpha });
    await makeFinalization(rfq_id, product_variant_id, IDS.users.vendor_alpha, quote_id);
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "draft",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      params: { po_id: String(po_id) },
    });
    await poController.initiatePO(m.req, m.res);

    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.data.approval_required).toBe(true);
    expect(m.calls.body.data.approval_type).toBe("new");
    expect(m.calls.body.data.approval_instance_id).toBeTruthy();

    // The approval instance must be against the A1/P1 PO policy and PENDING.
    const inst = await db.one(
      `SELECT entity_type, approval_policy_id, status FROM tbl_approval_instances WHERE id=$1`,
      [m.calls.body.data.approval_instance_id]
    );
    expect(inst.entity_type).toBe("PO");
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P1_PO);
    expect(inst.status).toBe("PENDING");

    // PO row should now have approval_instance_id populated and status=pending_approval.
    const after = await db.one(
      `SELECT status, approval_instance_id FROM tbl_rfq_purchase_order WHERE id=$1`,
      [po_id]
    );
    expect(after.status).toBe("pending_approval");
    expect(after.approval_instance_id).toBe(m.calls.body.data.approval_instance_id);
  });
});

describe("approvePO — multi-step approval drives handlePOPostApproval", () => {
  it("approveFully on a PO instance flips status pending_approval → acceptance_pending", async () => {
    const { rfq_id, rfq_product_id, product_variant_id, quote_id } =
      await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_alpha });
    await makeFinalization(rfq_id, product_variant_id, IDS.users.vendor_alpha, quote_id);
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "draft",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    // Initiate.
    const init = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      params: { po_id: String(po_id) },
    });
    await poController.initiatePO(init.req, init.res);
    expect(init.calls.body.data.approval_instance_id).toBeTruthy();
    const instanceId = init.calls.body.data.approval_instance_id;

    // Drive every step through the production engine via the helper.
    const final = await approveFully(instanceId);
    expect(final.instance.status).toBe("APPROVED");

    // Post-approval handler should have flipped PO status.
    const after = await db.one(
      `SELECT status, vendor_action_at FROM tbl_rfq_purchase_order WHERE id=$1`,
      [po_id]
    );
    expect(after.status).toBe("acceptance_pending");
  });

  it("rejectStep on the first PO approval step terminates the instance (REJECTED) and leaves the PO unsent", async () => {
    const { rfq_id, rfq_product_id, product_variant_id, quote_id } =
      await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_alpha });
    await makeFinalization(rfq_id, product_variant_id, IDS.users.vendor_alpha, quote_id);
    const po_id = await makePo({
      rfq_id, vendorId: IDS.users.vendor_alpha, status: "draft",
      rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
    });
    await attachProductToPo(po_id, rfq_product_id, quote_id);

    const init = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      params: { po_id: String(po_id) },
    });
    await poController.initiatePO(init.req, init.res);
    const instanceId = init.calls.body.data.approval_instance_id;

    const state = await getInstanceState(instanceId);
    const step1ApproverId = state.steps[0].approvers
      .find((a) => a.status === "PENDING").approver_user_id;

    const { rejectStep } = await import("../helpers/approval.js");
    const result = await rejectStep(instanceId, step1ApproverId, { comment: "vetoed" });
    expect(result.instance_status).toBe("REJECTED");

    // PO must NOT have flipped to acceptance_pending — it stays in
    // pending_approval (or moves to a rejected status depending on the
    // post-action handler). Critically, vendor_action_at must remain NULL
    // because no vendor has accepted.
    const after = await db.one(
      `SELECT status, vendor_action_at FROM tbl_rfq_purchase_order WHERE id=$1`,
      [po_id]
    );
    expect(after.vendor_action_at).toBeNull();
    expect(after.status).not.toBe("acceptance_pending");
    expect(after.status).not.toBe("approved");
  });
});

// ===========================================================================
//  Remaining deferred — narrow set, real blockers
// ===========================================================================

describe("PO full flow — remaining deferreds", () => {
  it.todo(
    "F-PO-001: same-vendor multi-product finalization surfaces merge_candidates in the API response (currently frontend-only)"
  );
  it.todo(
    "F-PO-FINAL-001: concurrent finalize race — needs concurrency harness (Wave 4 / Task 13)"
  );
  it.todo(
    "F-PO-PDF-001: PDF regeneration failure during approve is silently swallowed (mock Puppeteer to throw, assert approval still completes but error is logged)"
  );
  it.todo(
    "F-EMAIL-SCOPE-001: BU buyer recipient list strictly scoped to PO's hotel_id — assert no cross-hotel users notified (mock email service)"
  );
  it.todo(
    "F-PO-REMINDER-001: 3-tier reminder cron tier-drift on missed days (Wave 4 / Task 13 with time-mock)"
  );
  it.todo(
    "F-PO-EMAIL-002 (P2): the vendor-side PO confirmation email (sendPONotificationToVendor) MUST include the approval history (approvers + dates), matching the internal sendPOApprovalCompletionNotification. Needs email-capture mock to assert HTML body contents."
  );
});
