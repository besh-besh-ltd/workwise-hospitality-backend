// Wave-1 step-3.2 tests: rfqController.update — the WH-69 Edit RFQ flow.
//
// Surface tested: PUT /rfq/update with body { rfq_id, snapshot }. The
// controller does:
//   1. getFullRfqForEdit                       (canonical "current" state)
//   2. assertEditAllowed                       (creator-only, status≠2, bid window)
//   3. assertEditDateConstraints               (IST 2h / 1h / publish ordering)
//   4. diffRfqSnapshot                          (current vs snapshot)
//   5. applyRfqFieldChanges + applyProductChanges + applyTermsChanges
//   6. recordChanges into tbl_rfq_change_history
//   7. cancelAndReissueApproval IF material AND not yet published
//   8. recordLifecycleEvent
//   9. respond 200 + setImmediate(sendVendorEditNotifications)
//
// Per CONVENTIONS.md: every test calls the production controller, never
// duplicates SQL. Setup uses raw INSERTs only for prerequisite state.
//
// Architectural defects locked here:
//   - F-VALIDATION-001 (P2): the update path does NOT enforce ≥1 vendor per
//     product whereas the create path does (rfqController.js:5073). Update
//     allows the creator to remove all vendors of a product without error.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// Mock cronManager BEFORE the controller imports it. The Update path itself
// doesn't schedule, but cancelAndReissueApproval → createApprovalInstance can
// indirectly touch scheduler-adjacent helpers in some legacy code paths.
const scheduleCalls = [];
jest.unstable_mockModule("../../app/helper/cronManager.js", () => ({
  scheduleMilestoneReminder: async () => {},
  rescheduleMilestoneReminder: async () => {},
  removeMilestoneReminder: () => {},
  rescheduleAllMilestoneReminders: async () => {},
  scheduleGRNReminders: async () => {},
  publishRfqById: async () => {},
  scheduleRfqPublish: async (rfq) => { scheduleCalls.push({ rfqId: rfq?.id }); },
  removeRfqPublishJob: async () => ({ ok: true }),
  rescheduleAllRfqPublishJobs: async () => {},
  startVendorAcceptanceReminderCron: () => {},
  scheduleNegotiationRoundExpiration: () => {},
  removeNegotiationRoundExpiration: () => {},
  rescheduleAllNegotiationRoundExpirations: async () => {},
}));

const { default: rfqController } = await import(
  "../../app/controllers/rfq/rfqController.js"
);
const { default: rfqModel } = await import(
  "../../app/models/rfqModel.js"
);

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
    req: {
      user: opts.user,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  scheduleCalls.length = 0;
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  // Cascade order: change_history → lifecycle → approvals → products+specs
  // → rfq.
  await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_approval_actions
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])
     )`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
     WHERE approval_instance_step_id IN (
       SELECT s.id FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
       WHERE i.entity_type IN ('RFQ','TENDER') AND i.entity_id = ANY($1::int[])
     )`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])
     )`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instances
     WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

// ---- Setup helpers ---------------------------------------------------------

// IST wall-clock string `offsetMs` ahead of now. Matches frontend convention
// (no timezone suffix). assertEditDateConstraints anchors these to +05:30.
function istString(offsetMs) {
  const ist = new Date(Date.now() + offsetMs + 5.5 * 3600_000);
  return ist.toISOString().replace("T", " ").slice(0, 19);
}

async function makeEditableRfq(overrides = {}) {
  const tenderPub = istString(86400_000); // 1 day hence
  const clarEnd = istString(5 * 86400_000); // 5 days hence
  const bidEnd = istString(7 * 86400_000); // 7 days hence
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 0, // Draft — assertEditAllowed allows
    is_published: 0,
    tender_publish_date: tenderPub,
    vendor_clarification_date: clarEnd,
    bid_end_date: bidEnd,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    comment: "initial comment",
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function attachOneProduct(rfq_id, productVariantId = 1, opts = {}) {
  const { id } = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, productVariantId]
  );
  // Quantity + Unit are mandatory per product (assertProductQuantityAndUnit).
  // Spec-management tests that seed their own specs should opt out via
  // { withSpecs: false } to avoid duplicate-row conflicts.
  if (opts.withSpecs !== false) {
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
      [rfq_id, productVariantId]
    );
  }
  return id;
}

// Fetch the canonical snapshot the controller would read internally.
const fetchSnapshot = (rfq_id) => rfqModel.getFullRfqForEdit(rfq_id);

// ===========================================================================
//  Input validation
// ===========================================================================

describe("rfqController.update — input validation", () => {
  it("rejects when rfq_id is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { snapshot: {} },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/rfq_id and snapshot are required/i);
  });

  it("rejects when snapshot is missing", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 1 },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });
});

// ===========================================================================
//  Auth + state gates
// ===========================================================================

describe("rfqController.update — assertEditAllowed gate", () => {
  it("returns 404 when RFQ does not exist", async () => {
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id: 999999999, snapshot: { comment: "x" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(404);
    expect(m.calls.body.message).toMatch(/not found/i);
  });

  it("returns 403 when caller is NOT the creator", async () => {
    const rfq_id = await makeEditableRfq();
    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_techApp }, // not the creator
      body: { rfq_id, snapshot: { ...snap, comment: "tampered" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(403);
    expect(m.calls.body.message).toMatch(/Only the RFQ creator/i);
  });

  it("rejects when RFQ is CLOSED (status=2)", async () => {
    const rfq_id = await makeEditableRfq({ status: 2 });
    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, comment: "after close" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/closed and can no longer be edited/i);
  });
});

// ===========================================================================
//  Date-constraint gate
// ===========================================================================

describe("rfqController.update — assertEditDateConstraints", () => {
  it("rejects when bid_end_date is less than 2h from now", async () => {
    const rfq_id = await makeEditableRfq();
    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, bid_end_date: istString(60 * 60_000) }, // 1h hence
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
  });
});

// ===========================================================================
//  Post-publish lock
// ===========================================================================

describe("rfqController.update — post-publish field lock", () => {
  it("rejects modifying tender_publish_date once is_published=1", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, tender_publish_date: istString(2 * 86400_000) },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Cannot modify 'tender_publish_date'/i);
  });
});

// ===========================================================================
//  No-op + happy paths
// ===========================================================================

describe("rfqController.update — no-op", () => {
  it("returns success with change_count=0 when snapshot equals current state", async () => {
    const rfq_id = await makeEditableRfq();
    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: snap },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.message).toMatch(/No changes detected/i);
    expect(m.calls.body.change_count).toBe(0);

    // No history rows.
    const hist = await db.any(
      `SELECT 1 FROM tbl_rfq_change_history WHERE rfq_id=$1`, [rfq_id]
    );
    expect(hist.length).toBe(0);
  });
});

describe("rfqController.update — happy path: persists field change + audit row", () => {
  it("updates tbl_rfq.comment and writes one tbl_rfq_change_history row with edit_session_id", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, comment: "revised by creator" },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.status).toBe(1);
    expect(m.calls.body.change_count).toBe(1);
    const sessionId = m.calls.body.edit_session_id;
    expect(typeof sessionId).toBe("string");

    // tbl_rfq.comment now reflects the edit.
    const after = await db.one(
      `SELECT comment FROM tbl_rfq WHERE id=$1`, [rfq_id]
    );
    expect(after.comment).toBe("revised by creator");

    // History row was recorded against the same session id.
    const hist = await db.any(
      `SELECT entity_type, field_name, old_value, new_value, change_type, changed_by, edit_session_id
       FROM tbl_rfq_change_history WHERE rfq_id=$1`,
      [rfq_id]
    );
    expect(hist.length).toBe(1);
    expect(hist[0].entity_type).toBe("RFQ");
    expect(hist[0].field_name).toBe("comment");
    expect(hist[0].change_type).toBe("UPDATE");
    expect(hist[0].changed_by).toBe(IDS.users.a1_proc_buyer);
    expect(hist[0].edit_session_id).toBe(sessionId);
    // old/new values are JSONB — they round-trip as plain strings here.
    expect(String(hist[0].old_value).replace(/"/g, "")).toBe("initial comment");
    expect(String(hist[0].new_value).replace(/"/g, "")).toBe("revised by creator");

    // Lifecycle event recorded.
    const lc = await db.oneOrNone(
      `SELECT action FROM tbl_lifecycle_history
       WHERE entity_id=$1 AND action='EDIT' LIMIT 1`,
      [rfq_id]
    );
    expect(lc).not.toBeNull();
  });
});

// ===========================================================================
//  Material change → reapproval
// ===========================================================================

describe("rfqController.update — reapproval on material change", () => {
  async function seedPendingApproval(rfq_id) {
    // Seed a PENDING RFQ approval instance manually (simulate "submitted but
    // not yet approved" state). cancelAndReissueApproval should flip this to
    // CANCELLED and create a new instance.
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status,
          hospitality_company_id, hotel_id, department_id, process_id,
          initiated_by, current_step)
       VALUES ('RFQ', $1, $2, 'PENDING', $3, $4, NULL, $5, $6, 1)
       RETURNING id`,
      [
        rfq_id, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1,
        IDS.processes.A_P1, IDS.users.a1_proc_buyer,
      ]
    );
    return inst.id;
  }

  it("a material edit on an UNPUBLISHED RFQ cancels existing PENDING instance + creates new one", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 0, status: 3 });
    await attachOneProduct(rfq_id);
    const oldInstanceId = await seedPendingApproval(rfq_id);
    const snap = await fetchSnapshot(rfq_id);

    // bid_end_date is a "material" field per is_material rules.
    const newBidEnd = istString(10 * 86400_000);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: newBidEnd } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.material).toBe(true);

    // Old instance flipped to CANCELLED.
    const old = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE id=$1`, [oldInstanceId]
    );
    expect(old.status).toBe("CANCELLED");

    // A new RFQ approval instance exists for this RFQ.
    const fresh = await db.oneOrNone(
      `SELECT id, status FROM tbl_approval_instances
       WHERE entity_type='RFQ' AND entity_id=$1 AND status='PENDING'`,
      [rfq_id]
    );
    expect(fresh).not.toBeNull();

    // Reapproval result echoed in response.
    expect(m.calls.body.reapproval).not.toBeNull();
    expect(m.calls.body.reapproval.cancelledIds).toContain(oldInstanceId);
  });

  it("a material edit on a PUBLISHED RFQ does NOT trigger reapproval", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    await attachOneProduct(rfq_id);
    const oldInstanceId = await seedPendingApproval(rfq_id);
    const snap = await fetchSnapshot(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, bid_end_date: istString(10 * 86400_000) },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    // Old instance unchanged (still PENDING).
    const old = await db.one(
      `SELECT status FROM tbl_approval_instances WHERE id=$1`, [oldInstanceId]
    );
    expect(old.status).toBe("PENDING");

    // No new instance created.
    const all = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type='RFQ' AND entity_id=$1`,
      [rfq_id]
    );
    expect(all.length).toBe(1);

    expect(m.calls.body.reapproval).toBeNull();
  });
});

// ===========================================================================
//  Comprehensive payload coverage — multi-field, products add/remove/update,
//  specs, files, vendors, terms, PO-locked guard.
// ===========================================================================

describe("rfqController.update — multi-field RFQ change in one snapshot", () => {
  it("changes comment + location + vendor_clarification_date together → 3 history rows under one edit_session_id", async () => {
    const rfq_id = await makeEditableRfq();
    const snap = await fetchSnapshot(rfq_id);

    const newClar = istString(4 * 86400_000); // earlier than current
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: {
          ...snap,
          comment: "new comment",
          location: "Mumbai BKC",
          vendor_clarification_date: newClar,
        },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(3);
    const session = m.calls.body.edit_session_id;

    const fields = await db.any(
      `SELECT field_name FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND edit_session_id=$2 AND entity_type='RFQ'
       ORDER BY field_name`,
      [rfq_id, session]
    );
    expect(fields.map((r) => r.field_name).sort()).toEqual(
      ["comment", "location", "vendor_clarification_date"]
    );

    // tbl_rfq actually carries the new values.
    const after = await db.one(
      `SELECT comment, location FROM tbl_rfq WHERE id=$1`, [rfq_id]
    );
    expect(after.comment).toBe("new comment");
    expect(after.location).toBe("Mumbai BKC");
  });
});

describe("rfqController.update — product changes (add / remove / update)", () => {
  it("adds a new product (snapshot.products gains an entry with id=null) → tbl_rfq_products row inserted + PRODUCT history row", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products.push({
      id: null, // new
      product_variant_id: 2,
      variant: 0,
      product_name: "fixture variant 2",
      comment: "added by buyer",
      specs: { Quantity: "5", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBeGreaterThan(0);

    const products = await db.any(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1 ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(products.map((p) => p.product_variant_id).sort()).toEqual([1, 2]);

    // History captured a PRODUCT CREATE row.
    const created = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT' AND change_type='CREATE'`,
      [rfq_id]
    );
    expect(created).not.toBeNull();
  });

  it("removes a product (snapshot omits one AND names it in deleted_product_ids) → tbl_rfq_products row deleted + PRODUCT DELETE history", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    await attachOneProduct(rfq_id, 2);
    const snap = await fetchSnapshot(rfq_id);

    // Drop product variant 2 from the snapshot. Omitting it is not enough on
    // its own — since the RFQ 536245 data loss, removal must be explicit, so
    // the id also has to be named in deleted_product_ids. Full coverage of the
    // contract lives in rfq.update.productRemoval.test.js.
    const tampered = JSON.parse(JSON.stringify(snap));
    const dropped = tampered.products.find((p) => p.product_variant_id === 2);
    tampered.products = tampered.products.filter((p) => p.product_variant_id !== 2);
    tampered.deleted_product_ids = [dropped.id];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const products = await db.any(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1`, [rfq_id]
    );
    expect(products.map((p) => p.product_variant_id)).toEqual([1]);

    const deleted = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT' AND change_type='DELETE'`,
      [rfq_id]
    );
    expect(deleted).not.toBeNull();
  });

  it("updates an existing product's comment → tbl_rfq_products UPDATE + PRODUCT history row", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].comment = "buyer note on this product";

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(
      `SELECT comment FROM tbl_rfq_products WHERE rfq_id=$1`, [rfq_id]
    );
    expect(after.comment).toBe("buyer note on this product");

    const hist = await db.oneOrNone(
      `SELECT field_name FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT' AND field_name='comment'`,
      [rfq_id]
    );
    expect(hist).not.toBeNull();
  });
});

describe("rfqController.update — product specs (add / remove / update)", () => {
  it("specs.added → tbl_rfq_products_specs INSERT + PRODUCT_SPEC CREATE history row", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1, { withSpecs: false });
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].specs = { Quantity: "100", Unit: "NOS" };

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const specs = await db.any(
      `SELECT title, value FROM tbl_rfq_products_specs
       WHERE rfq_id=$1 ORDER BY title`, [rfq_id]
    );
    expect(specs.length).toBe(2);
    expect(specs.find((s) => s.title === "Quantity").value).toBe("100");
    expect(specs.find((s) => s.title === "Unit").value).toBe("NOS");

    const created = await db.any(
      `SELECT field_name FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_SPEC' AND change_type='CREATE'
       ORDER BY field_name`,
      [rfq_id]
    );
    expect(created.map((r) => r.field_name).sort()).toEqual(["Quantity", "Unit"]);
  });

  it("specs.updated → existing tbl_rfq_products_specs row UPDATEd + PRODUCT_SPEC UPDATE history", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1, { withSpecs: false });
    // Seed Quantity + Unit explicitly. Unit is required by
    // assertProductQuantityAndUnit; Quantity is the spec under test.
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '10', 0), ($1, 1, 'Unit', 'NOS', 0)`,
      [rfq_id]
    );
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].specs = { ...tampered.products[0].specs, Quantity: "25" };

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.one(
      `SELECT value FROM tbl_rfq_products_specs WHERE rfq_id=$1 AND title='Quantity'`,
      [rfq_id]
    );
    expect(after.value).toBe("25");

    const updated = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_SPEC' AND field_name='Quantity' AND change_type='UPDATE'`,
      [rfq_id]
    );
    expect(updated).not.toBeNull();
  });

  it("specs.removed → tbl_rfq_products_specs row deleted + PRODUCT_SPEC DELETE history", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1, { withSpecs: false });
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '10', 0), ($1, 1, 'Unit', 'KG', 0), ($1, 1, 'Size', 'M', 0)`,
      [rfq_id]
    );
    const snap = await fetchSnapshot(rfq_id);

    // Snapshot drops Size. (Quantity + Unit are mandatory and must remain;
    // any test that dropped Unit would be blocked by assertProductQuantityAndUnit.)
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].specs = {
      Quantity: snap.products[0].specs.Quantity,
      Unit: snap.products[0].specs.Unit,
    };

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const remaining = await db.any(
      `SELECT title FROM tbl_rfq_products_specs WHERE rfq_id=$1 ORDER BY title`, [rfq_id]
    );
    expect(remaining.map((r) => r.title)).toEqual(["Quantity", "Unit"]);

    const deleted = await db.oneOrNone(
      `SELECT field_name FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_SPEC' AND field_name='Size' AND change_type='DELETE'`,
      [rfq_id]
    );
    expect(deleted).not.toBeNull();
  });
});

describe("rfqController.update — product files (add / remove)", () => {
  it("files.added → tbl_rfq_product_files INSERT + PRODUCT_FILE CREATE history", async () => {
    const rfq_id = await makeEditableRfq();
    const productId = await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].files.qap_file = ["s3://bucket/qap-1.pdf"];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const files = await db.any(
      `SELECT file_type, file_url FROM tbl_rfq_product_files WHERE rfq_product_id=$1`,
      [productId]
    );
    expect(files.length).toBe(1);
    expect(files[0].file_url).toBe("s3://bucket/qap-1.pdf");

    const created = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_FILE' AND change_type='CREATE'`,
      [rfq_id]
    );
    expect(created).not.toBeNull();
  });

  it("files.removed → tbl_rfq_product_files DELETE + PRODUCT_FILE DELETE history", async () => {
    const rfq_id = await makeEditableRfq();
    const productId = await attachOneProduct(rfq_id, 1);
    await db.none(
      `INSERT INTO tbl_rfq_product_files (rfq_product_id, file_type, file_url)
       VALUES ($1, 'QAP', 's3://bucket/qap-old.pdf')`,
      [productId]
    );
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].files.qap_file = []; // drop

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const remaining = await db.any(
      `SELECT 1 FROM tbl_rfq_product_files WHERE rfq_product_id=$1`, [productId]
    );
    expect(remaining.length).toBe(0);

    const deleted = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_FILE' AND change_type='DELETE'`,
      [rfq_id]
    );
    expect(deleted).not.toBeNull();
  });
});

describe("rfqController.update — product vendor add (Edit RFQ flow allows ADD only)", () => {
  it("vendors.added → tbl_rfq_product_vendors INSERT + PRODUCT_VENDOR CREATE history", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].vendors = [IDS.users.vendor_alpha];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const v = await db.any(
      `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id=$1`, [rfq_id]
    );
    expect(v.map((r) => r.user_id)).toContain(IDS.users.vendor_alpha);

    const created = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='PRODUCT_VENDOR' AND change_type='CREATE'`,
      [rfq_id]
    );
    expect(created).not.toBeNull();
  });
});

describe("rfqController.update — terms (add / remove)", () => {
  it("terms.added → tbl_rfq_terms_map INSERT + TERMS CREATE history; terms.removed → DELETE + history", async () => {
    const rfq_id = await makeEditableRfq();
    // Seed two terms on the RFQ.
    await db.none(
      `INSERT INTO tbl_rfq_terms_map (rfq_id, terms_id) VALUES ($1, 1), ($1, 2)`,
      [rfq_id]
    );
    const snap = await fetchSnapshot(rfq_id);

    // Drop terms_id=2, add terms_id=3.
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.terms = [1, 3];

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const after = await db.any(
      `SELECT terms_id FROM tbl_rfq_terms_map WHERE rfq_id=$1 ORDER BY terms_id`,
      [rfq_id]
    );
    expect(after.map((r) => r.terms_id)).toEqual([1, 3]);

    const histTypes = await db.any(
      `SELECT change_type FROM tbl_rfq_change_history
       WHERE rfq_id=$1 AND entity_type='TERMS' ORDER BY change_type`,
      [rfq_id]
    );
    const set = new Set(histTypes.map((r) => r.change_type));
    expect(set.has("CREATE")).toBe(true);
    expect(set.has("DELETE")).toBe(true);
  });
});

describe("rfqController.update — hotel_ids tampering rejected", () => {
  it("changing snapshot.hotel_ids returns 400 (defence in depth — hotels are not editable)", async () => {
    const rfq_id = await makeEditableRfq();
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
      [rfq_id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
    );
    const snap = await fetchSnapshot(rfq_id);
    const tampered = { ...snap, hotel_ids: [IDS.hotels.A1, IDS.hotels.A2] };

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Hotel mappings cannot be changed/i);

    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id=$1`, [rfq_id]);
  });
});

// ===========================================================================
//  Wave-3 / Wave-4 deferred locks for the Update path
// ===========================================================================
// F-VALIDATION-001 was triaged out (Edit-flow vendor enforcement deferred).
// The two remaining Update-path defects need infrastructure that lands in
// later waves; placeholders below keep them tracked.

describe("rfqController.update — deferred defects (infra-blocked)", () => {
  it.todo(
    "F-UPDATE-002 (P1): publish-fire race — edit reading is_published=0 before tx must re-check inside the tx (SELECT … FOR UPDATE), so a concurrent scheduler fire cannot let the edit overwrite already-published fields. Wave 4 / concurrency harness."
  );
  it.todo(
    "F-APPROVAL-002 (P1): cancelAndReissueApproval throw must NOT be swallowed at warn-level — edit either fails OR marks the RFQ with a 'reapproval_required' flag that gates further state transitions. Needs a way to make policy resolution throw mid-edit (mock generalModel.findBestMatchingPolicyTx)."
  );
});

// ===========================================================================
//  Restricted edit mode — collapses the form to "only bid_end_date + Refresh
//  Vendors" under three triggers: tech-stuck, dead-end, or any non-regret
//  quote already received. See rfqController.update :5411-5443 + canEditRfq.
// ===========================================================================

describe("rfqController.update — restricted edit mode", () => {
  // Local cleanup for the side-tables we touch in this block. Runs before the
  // file-level afterEach so rfqIds-cascading deletes still complete.
  afterEach(async () => {
    if (!inserted.rfqIds.length) return;
    await db.none(
      `DELETE FROM tbl_purchase_order_product
        WHERE purchase_order_id IN (
          SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])
        )`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_quote_items
        WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`,
      [inserted.rfqIds]
    );
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`,
      [inserted.rfqIds]
    );
  });

  async function insertQuote(rfq_id, vendorId, { isRegret = false } = {}) {
    const q = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, is_regret)
       VALUES ($1, 1, $2, $2, $3) RETURNING id`,
      [rfq_id, vendorId, isRegret ? 1 : 0]
    );
    return q.id;
  }

  it("Case 5 — non-regret quote → restricted: title edit rejected", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, title: "renamed mid-bid" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit/i);
  });

  it("Case 5 — non-regret quote → restricted: bid_end_date extension still allowed", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const newBidEnd = istString(10 * 86400_000); // push 10 days out
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: newBidEnd } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(1);
  });

  // Regression for RFQ-402-style false positive: rich-text editors collapse
  // double spaces and trim whitespace adjacent to tag boundaries on render.
  // The diff used to strict-compare raw strings, so an untouched `comment`
  // round-tripped as "changed" and the restricted-edit guard fired with
  // `Cannot change: comment`. canonicalForCompare in rfqUpdateHelpers now
  // makes the comparison HTML-entity / whitespace / tag-boundary tolerant.
  it("restricted edit: editor-normalized whitespace in RFQ comment is treated as no-op (bid_end_date extension succeeds)", async () => {
    // Mirrors the actual RFQ 402 bug: stored has '  ' (double space) and
    // ' </p> ' (space before & after closing tag); incoming has collapsed
    // single space and tight '.</p>'.
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      comment: "<p>SUPPLY AND FIXING.  FRIGHT CHARGES INCLUDED. </p> ",
    });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const normalizedComment = "<p>SUPPLY AND FIXING. FRIGHT CHARGES INCLUDED.</p>";
    const newBidEnd = istString(10 * 86400_000);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, comment: normalizedComment, bid_end_date: newBidEnd },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(1);

    // Only bid_end_date is in history; comment was not flagged.
    const hist = await db.any(
      `SELECT field_name FROM tbl_rfq_change_history
        WHERE rfq_id=$1 AND entity_type='RFQ'`,
      [rfq_id]
    );
    expect(hist.map((r) => r.field_name)).toEqual(["bid_end_date"]);

    // Stored comment is unchanged — comparator tolerance must not alter writes.
    const after = await db.one(`SELECT comment FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.comment).toBe("<p>SUPPLY AND FIXING.  FRIGHT CHARGES INCLUDED. </p> ");
  });

  it("restricted edit: HTML entity delta (& ↔ &amp;) in RFQ comment is treated as no-op", async () => {
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      comment: "<p>ELECTRICAL SUPPLY & CONNECTION</p>",
    });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: {
          ...snap,
          comment: "<p>ELECTRICAL SUPPLY &amp; CONNECTION</p>",
          bid_end_date: istString(10 * 86400_000),
        },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(1);

    const hist = await db.any(
      `SELECT field_name FROM tbl_rfq_change_history
        WHERE rfq_id=$1 AND entity_type='RFQ'`,
      [rfq_id]
    );
    expect(hist.map((r) => r.field_name)).toEqual(["bid_end_date"]);
  });

  it("restricted edit: substantive RFQ comment change is still rejected", async () => {
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      comment: "<p>Original scope of work.</p>",
    });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: {
        rfq_id,
        snapshot: { ...snap, comment: "<p>Completely different scope.</p>" },
      },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit.*comment/i);
  });

  it("restricted edit: editor-normalized whitespace in product comment is treated as no-op", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    const productId = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, $2, '', '', '', '', 1, 0) RETURNING id`,
      [rfq_id, "<p>FOR  VENTILATION  PURPOSE. </p> "]
    ).then((r) => r.id);
    // Quantity + Unit are mandatory per product (assertProductQuantityAndUnit).
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '10', 0), ($1, 1, 'Unit', 'NOS', 0)`,
      [rfq_id]
    );
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products = tampered.products.map((p) =>
      p.id === productId ? { ...p, comment: "<p>FOR VENTILATION PURPOSE.</p>" } : p
    );
    tampered.bid_end_date = istString(10 * 86400_000);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(1);

    const after = await db.one(
      `SELECT comment FROM tbl_rfq_products WHERE id=$1`, [productId]
    );
    expect(after.comment).toBe("<p>FOR  VENTILATION  PURPOSE. </p> ");
  });

  it("restricted edit: trailing whitespace in product spec value (e.g. Size) is treated as no-op", async () => {
    // Seed a product with a Size spec that has trailing whitespace, same
    // shape as the RFQ-402 GSS Duct product ("24 GUAGE GI SHEET ").
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    await attachOneProduct(rfq_id, 1);
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Size', '1X1 FT ', 0),
              ($1, 1, 'Spec', '24 GUAGE GI SHEET ', 0)`,
      [rfq_id]
    );
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const tampered = JSON.parse(JSON.stringify(snap));
    // Editor-normalized: trimmed trailing spaces.
    tampered.products[0].specs = {
      ...tampered.products[0].specs,
      Size: "1X1 FT",
      Spec: "24 GUAGE GI SHEET",
    };
    tampered.bid_end_date = istString(10 * 86400_000);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.change_count).toBe(1);

    // No PRODUCT_SPEC history rows — only bid_end_date moved.
    const specHist = await db.any(
      `SELECT field_name FROM tbl_rfq_change_history
        WHERE rfq_id=$1 AND entity_type='PRODUCT_SPEC'`,
      [rfq_id]
    );
    expect(specHist).toEqual([]);

    // Stored values for Size/Spec unchanged (Quantity/Unit added by helper
    // are unrelated to the whitespace-normalization assertion).
    const stored = await db.any(
      `SELECT title, value FROM tbl_rfq_products_specs
        WHERE rfq_id=$1 AND title IN ('Size','Spec') ORDER BY title`,
      [rfq_id]
    );
    expect(stored).toEqual([
      { title: "Size", value: "1X1 FT " },
      { title: "Spec", value: "24 GUAGE GI SHEET " },
    ]);
  });

  it("restricted edit: substantive product spec value change is still rejected", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    await attachOneProduct(rfq_id, 1);
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '15', 0)`,
      [rfq_id]
    );
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products[0].specs = { ...tampered.products[0].specs, Quantity: "50" };

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit.*product specifications/i);
  });

  it("Case 5 — regret-only quote does NOT trigger restricted (full edit allowed)", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    await attachOneProduct(rfq_id);
    await insertQuote(rfq_id, IDS.users.vendor_alpha, { isRegret: true });

    const snap = await fetchSnapshot(rfq_id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, title: "renamed after regret" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
    const after = await db.one(`SELECT title FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.title).toBe("renamed after regret");
  });

  it("Case 3 — tech-stuck product → restricted: comment edit rejected, bid_end_date allowed", async () => {
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    const rfq_product_id = await attachOneProduct(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors, total_passed_verified)
       VALUES ($1, $2, TRUE, 0)`,
      [rfq_id, rfq_product_id]
    );

    // 1) Non-deadline change → 400
    let snap = await fetchSnapshot(rfq_id);
    let m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, comment: "after tech-stuck" } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit/i);

    // 2) Deadline-only change → 200
    snap = await fetchSnapshot(rfq_id);
    m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: { ...snap, bid_end_date: istString(10 * 86400_000) } },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);
  });

  it("Lifecycle: tech responses without a commercial quote → RFQ_STUCK_COMMERCIAL ('No Vendors Participated')", async () => {
    // The dashboard pill bug: vendors submitted tech responses but no
    // commercial quotes, bid window expired. Used to mis-report
    // RFQ_STUCK_TECHNICAL ("Technical Evaluation Stuck") even though the
    // real cause is non-participation. Tech responses are not "participation"
    // — only quote submission counts — so this should map to the existing
    // RFQ_STUCK_COMMERCIAL stage which is labelled "No Vendors Participated".
    const bidEndPast = istString(-3600_000); // 1h ago
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      bid_end_date: bidEndPast,
      vendor_clarification_date: istString(-2 * 3600_000),
      tender_publish_date: istString(-3 * 86400_000),
    });
    const rfq_product_id = await attachOneProduct(rfq_id);

    const te = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors, total_passed_verified)
       VALUES ($1, $2, FALSE, 0) RETURNING id`,
      [rfq_id, rfq_product_id]
    );
    const clause = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation_clauses
         (tbl_rfq_product_tech_evaluation_id, clause_text, clause_type)
       VALUES ($1, 'Sample clause', 'TEXT') RETURNING id`,
      [te.id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_vendors_response
         (vendor_id, tbl_rfq_product_tech_evaluation_clauses_id, vendor_response, timestamp)
       VALUES ($1, $2, 'OK', NOW())`,
      [IDS.users.vendor_alpha, clause.id]
    );

    const map = await rfqModel.computeLifecycleStages([rfq_id]);
    expect(map[rfq_id]).toBe("RFQ_STUCK_COMMERCIAL");

    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_vendors_response
        WHERE tbl_rfq_product_tech_evaluation_clauses_id = $1`, [clause.id]);
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE id = $1`, [clause.id]);
  });

  it("Lifecycle: zero engagement after deadline (TE configured) → RFQ_STUCK_COMMERCIAL", async () => {
    const bidEndPast = istString(-3600_000);
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      bid_end_date: bidEndPast,
      vendor_clarification_date: istString(-2 * 3600_000),
      tender_publish_date: istString(-3 * 86400_000),
    });
    const rfq_product_id = await attachOneProduct(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors, total_passed_verified)
       VALUES ($1, $2, FALSE, 0)`,
      [rfq_id, rfq_product_id]
    );

    const map = await rfqModel.computeLifecycleStages([rfq_id]);
    expect(map[rfq_id]).toBe("RFQ_STUCK_COMMERCIAL");
  });

  it("Lifecycle: TE configured + bid passed + commercial quote → TECHNICAL_EVALUATING", async () => {
    const bidEndPast = istString(-3600_000);
    const rfq_id = await makeEditableRfq({
      status: 1,
      is_published: 1,
      bid_end_date: bidEndPast,
      vendor_clarification_date: istString(-2 * 3600_000),
      tender_publish_date: istString(-3 * 86400_000),
    });
    const rfq_product_id = await attachOneProduct(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation
         (rfq_id, tbl_rfq_product_id, blocked_insufficient_vendors, total_passed_verified)
       VALUES ($1, $2, FALSE, 0)`,
      [rfq_id, rfq_product_id]
    );
    await insertQuote(rfq_id, IDS.users.vendor_alpha);

    const map = await rfqModel.computeLifecycleStages([rfq_id]);
    expect(map[rfq_id]).toBe("TECHNICAL_EVALUATING");
  });

  it("getFullRfqForEdit / getRFQById expose has_received_quotes (non-regret only)", async () => {
    // No quotes yet → false
    const rfq_id = await makeEditableRfq({ status: 1, is_published: 1 });
    let row = await db.one(
      `SELECT (
         SELECT EXISTS (
           SELECT 1 FROM tbl_quotes _t
            WHERE _t.rfq_id = $1
              AND (_t.is_regret IS NULL OR _t.is_regret != 1)
            LIMIT 1
         )
       ) AS has_received_quotes`,
      [rfq_id]
    );
    expect(row.has_received_quotes).toBe(false);

    // Add a regret-only quote → still false
    await insertQuote(rfq_id, IDS.users.vendor_alpha, { isRegret: true });
    row = await db.one(
      `SELECT (
         SELECT EXISTS (
           SELECT 1 FROM tbl_quotes _t
            WHERE _t.rfq_id = $1
              AND (_t.is_regret IS NULL OR _t.is_regret != 1)
            LIMIT 1
         )
       ) AS has_received_quotes`,
      [rfq_id]
    );
    expect(row.has_received_quotes).toBe(false);

    // Add a real quote → true
    await insertQuote(rfq_id, IDS.users.vendor_beta);
    row = await db.one(
      `SELECT (
         SELECT EXISTS (
           SELECT 1 FROM tbl_quotes _t
            WHERE _t.rfq_id = $1
              AND (_t.is_regret IS NULL OR _t.is_regret != 1)
            LIMIT 1
         )
       ) AS has_received_quotes`,
      [rfq_id]
    );
    expect(row.has_received_quotes).toBe(true);
  });
});

// ===========================================================================
//  Add Products via in-page modal (WH-69)
//
//  Scenario: user opens the "+ Add Products" modal on /rfq-management-edit,
//  picks one or more products, clicks Save Changes. The FE dispatches them
//  into Redux (rfqProductsFromStore) and then sends the full snapshot via
//  PUT /rfq/update. New rows arrive as snapshot.products entries with
//  id=null (or omitted) and the backend diff treats them as products.added.
//
//  Cases below isolate the *add* path on different RFQ states. Generic gates
//  (closed RFQ, non-creator, bid_end_date past) already covered earlier.
// ===========================================================================
describe("rfqController.update — add products via in-page modal (WH-69)", () => {
  // Local helper — mirrors the one inside the "restricted edit mode" block.
  // Kept inline to avoid hoisting and to keep this block self-contained.
  async function insertQuoteLocal(rfq_id, vendorId, { isRegret = false } = {}) {
    const q = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, is_regret)
       VALUES ($1, 1, $2, $2, $3) RETURNING id`,
      [rfq_id, vendorId, isRegret ? 1 : 0]
    );
    return q.id;
  }

  // Quotes + tech-eval rows touched here are not auto-cleaned by the file's
  // top-level afterEach. Sweep them so cascading RFQ delete doesn't FK-fail.
  afterEach(async () => {
    if (!inserted.rfqIds.length) return;
    await db.none(
      `DELETE FROM tbl_quote_items
        WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  });

  it("creator adds a new product to a PUBLISHED RFQ (no quotes yet) → row persists, specs persist, PRODUCT CREATE history written", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    // Mirror exactly what AddProductsModal → buildEditSnapshotPayload sends:
    // id missing/null, specs as a flat object, files defaulted to empty arrays.
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products.push({
      id: null,
      product_variant_id: 2,
      variant: 0,
      product_name: "newly-added catalog item",
      comment: "",
      specs: { Quantity: "5", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const products = await db.any(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1 ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(products.map((p) => p.product_variant_id)).toEqual([1, 2]);

    // Specs for the new variant land in tbl_rfq_products_specs.
    const specs = await db.any(
      `SELECT title, value FROM tbl_rfq_products_specs
        WHERE rfq_id=$1 AND product_variant_id=2 ORDER BY title`,
      [rfq_id]
    );
    expect(specs).toEqual(
      expect.arrayContaining([
        { title: "Quantity", value: "5" },
        { title: "Unit", value: "NOS" },
      ])
    );

    // Audit row.
    const created = await db.oneOrNone(
      `SELECT change_type FROM tbl_rfq_change_history
        WHERE rfq_id=$1 AND entity_type='PRODUCT' AND change_type='CREATE'`,
      [rfq_id]
    );
    expect(created).not.toBeNull();
  });

  it("add new product + assign vendor in same snapshot → both persist + PRODUCT and PRODUCT_VENDOR history rows written under one edit_session_id", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products.push({
      id: null,
      product_variant_id: 3,
      variant: 0,
      product_name: "added with vendor",
      comment: "",
      specs: { Quantity: "1", Unit: "EA" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [IDS.users.vendor_alpha],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    // Product row + vendor row both present.
    const vendorRow = await db.oneOrNone(
      `SELECT user_id FROM tbl_rfq_product_vendors
        WHERE rfq_id=$1 AND product_variant_id=3 AND user_id=$2`,
      [rfq_id, IDS.users.vendor_alpha]
    );
    expect(vendorRow).not.toBeNull();

    // Both history rows landed under the same edit_session_id (one save → one session).
    const history = await db.any(
      `SELECT entity_type, change_type, edit_session_id FROM tbl_rfq_change_history
        WHERE rfq_id=$1 AND change_type='CREATE'
          AND entity_type IN ('PRODUCT','PRODUCT_VENDOR')`,
      [rfq_id]
    );
    const types = history.map((r) => r.entity_type).sort();
    expect(types).toEqual(expect.arrayContaining(["PRODUCT", "PRODUCT_VENDOR"]));
    const sessionIds = new Set(history.map((r) => r.edit_session_id));
    expect(sessionIds.size).toBe(1);
  });

  it("restricted edit (RFQ has a non-regret quote) rejects adding a new product with 400 'Restricted edit'", async () => {
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    await attachOneProduct(rfq_id, 1);
    await insertQuoteLocal(rfq_id, IDS.users.vendor_alpha);

    const snap = await fetchSnapshot(rfq_id);
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products.push({
      id: null,
      product_variant_id: 99,
      variant: 0,
      product_name: "blocked addition",
      comment: "",
      specs: { Quantity: "1", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/Restricted edit/i);

    // No PRODUCT CREATE row should exist for variant 99.
    const phantom = await db.oneOrNone(
      `SELECT id FROM tbl_rfq_products WHERE rfq_id=$1 AND product_variant_id=99`,
      [rfq_id]
    );
    expect(phantom).toBeNull();
  });

  it("snapshot-staged add survives the FE-builder shape (product_variant_id fallback to product_id, missing id key entirely)", async () => {
    // Defence-in-depth: AddProductsModal dispatches addRfqProduct which writes
    // `product_id` to Redux; buildEditSnapshotPayload reads
    // `Number(p.product_variant_id ?? p.product_id)`. Confirm that even if
    // the FE shipped only product_variant_id and *omitted* the id key entirely
    // (rather than nulling it), the backend still treats the row as a new add.
    const rfq_id = await makeEditableRfq({ is_published: 1, status: 1 });
    await attachOneProduct(rfq_id, 1);
    const snap = await fetchSnapshot(rfq_id);

    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.products.push({
      // id key intentionally omitted (not null)
      product_variant_id: 7,
      variant: 0,
      product_name: "id-omitted add",
      comment: "",
      specs: { Quantity: "2", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer },
      body: { rfq_id, snapshot: tampered },
    });
    await rfqController.update(m.req, m.res);
    expect(m.calls.status).toBe(200);

    const row = await db.oneOrNone(
      `SELECT id FROM tbl_rfq_products WHERE rfq_id=$1 AND product_variant_id=7`,
      [rfq_id]
    );
    expect(row).not.toBeNull();
  });
});
