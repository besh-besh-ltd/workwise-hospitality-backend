// Product removal through the WH-69 Edit RFQ flow (PUT /rfq/update).
//
// Two production defects are locked here, both surfaced by RFQ 536245 on
// 2026-08-26 (ORCHID PASSAROS GOA):
//
//   1. The buyer removed a product, saved, and nothing was deleted. The
//      frontend filed the removal in client-only state and still sent the
//      product in the snapshot, so the server saw it as present. Fixed on the
//      frontend (utils/rfqEditSnapshot.js); the contract that makes the fix
//      legible is `snapshot.deleted_product_ids`, asserted here.
//
//   2. Deletion used to be implied by omission: any product the snapshot did
//      not mention was cascade-deleted. Four overlapping saves left the
//      browser in six seconds, and the last one carried a snapshot that
//      predated the other three — so it destroyed two products and 226 vendor
//      mappings that had just been created. `getFullRfqForEdit` takes no row
//      lock, so nothing stopped it.
//
// The contract now: the server deletes a product only when the snapshot names
// it in `deleted_product_ids`. A product that is merely missing is treated as
// a stale snapshot and the whole update is refused with 409.
//
// Per CONVENTIONS.md: every test drives the production controller against real
// Postgres. Raw INSERTs are used only to seed prerequisite state.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

jest.unstable_mockModule("../../app/helper/cronManager.js", () => ({
  scheduleMilestoneReminder: async () => {},
  rescheduleMilestoneReminder: async () => {},
  removeMilestoneReminder: () => {},
  rescheduleAllMilestoneReminders: async () => {},
  scheduleGRNReminders: async () => {},
  publishRfqById: async () => {},
  scheduleRfqPublish: async () => {},
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
const { default: rfqModel } = await import("../../app/models/rfqModel.js");

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
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(
    `DELETE FROM tbl_approval_actions
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
     WHERE approval_instance_step_id IN (
       SELECT s.id FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
       WHERE i.entity_type IN ('RFQ','TENDER') AND i.entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instance_steps
     WHERE approval_instance_id IN (
       SELECT id FROM tbl_approval_instances
       WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[]))`,
    [inserted.rfqIds]
  );
  await db.none(
    `DELETE FROM tbl_approval_instances
     WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`,
    [inserted.rfqIds]
  );
  await db.none(`DELETE FROM tbl_rfq_product_files WHERE rfq_product_id IN (SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[]))`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
});

function istString(offsetMs) {
  const ist = new Date(Date.now() + offsetMs + 5.5 * 3600_000);
  return ist.toISOString().replace("T", " ").slice(0, 19);
}

async function makeEditableRfq(overrides = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 0,
    is_published: 0,
    tender_publish_date: istString(86400_000),
    vendor_clarification_date: istString(5 * 86400_000),
    bid_end_date: istString(7 * 86400_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
    comment: "initial comment",
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

async function attachOneProduct(rfq_id, productVariantId = 1, variant = 0) {
  const { id } = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, $3) RETURNING id`,
    [rfq_id, productVariantId, variant]
  );
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', $3), ($1, $2, 'Unit', 'NOS', $3)`,
    [rfq_id, productVariantId, variant]
  );
  return id;
}

const fetchSnapshot = (rfq_id) => rfqModel.getFullRfqForEdit(rfq_id);

const update = async (rfq_id, snapshot, userId = IDS.users.a1_proc_buyer) => {
  const m = mockExpress({ user: { id: userId }, body: { rfq_id, snapshot } });
  await rfqController.update(m.req, m.res);
  return m.calls;
};

const productIds = (rfq_id) =>
  db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id=$1 ORDER BY id`, [rfq_id])
    .then((rows) => rows.map((r) => Number(r.id)));

const deleteHistory = (rfq_id) =>
  db.any(
    `SELECT entity_id FROM tbl_rfq_change_history
      WHERE rfq_id=$1 AND entity_type='PRODUCT' AND change_type='DELETE'`,
    [rfq_id]
  );

// ===========================================================================
//  Explicit removal — the buyer asked for it
// ===========================================================================

describe("rfqController.update — removing a product the buyer marked for removal", () => {
  it("deletes the product named in deleted_product_ids", async () => {
    const rfq_id = await makeEditableRfq();
    const keep = await attachOneProduct(rfq_id, 1);
    const drop = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== drop);
    payload.deleted_product_ids = [drop];

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(200);
    expect(await productIds(rfq_id)).toEqual([keep]);
  });

  it("writes a PRODUCT DELETE history row for the removed product", async () => {
    // The buyer-facing Edit History panel reads this. Before the fix it never
    // had a row to render for a removal, because removals never happened.
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const drop = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== drop);
    payload.deleted_product_ids = [drop];

    await update(rfq_id, payload);

    const rows = await deleteHistory(rfq_id);
    expect(rows.map((r) => Number(r.entity_id))).toEqual([drop]);
  });

  it("cascades the removed product's specs and vendor mappings", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const drop = await attachOneProduct(rfq_id, 2);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, variant, user_id)
       VALUES ($1, 2, 0, $2)`,
      [rfq_id, IDS.users.a1_proc_buyer]
    );

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== drop);
    payload.deleted_product_ids = [drop];

    expect((await update(rfq_id, payload)).status).toBe(200);

    const specs = await db.any(
      `SELECT 1 FROM tbl_rfq_products_specs WHERE rfq_id=$1 AND product_variant_id=2`, [rfq_id]
    );
    const vendors = await db.any(
      `SELECT 1 FROM tbl_rfq_product_vendors WHERE rfq_id=$1 AND product_variant_id=2`, [rfq_id]
    );
    expect(specs).toEqual([]);
    expect(vendors).toEqual([]);
  });

  it("removes several products in one save", async () => {
    // RFQ 536245 ended up with two identical duplicate rows; clearing them in
    // a single save has to work.
    const rfq_id = await makeEditableRfq();
    const keep = await attachOneProduct(rfq_id, 1);
    const dropA = await attachOneProduct(rfq_id, 2);
    const dropB = await attachOneProduct(rfq_id, 3);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter(
      (p) => Number(p.id) !== dropA && Number(p.id) !== dropB
    );
    payload.deleted_product_ids = [dropA, dropB];

    expect((await update(rfq_id, payload)).status).toBe(200);
    expect(await productIds(rfq_id)).toEqual([keep]);
  });

  it("removes one duplicate while keeping its identical twin", async () => {
    // The exact shape of RFQ 536245: two rows, same product_variant_id,
    // different `variant`, byte-identical specs. Deleting by row id must not
    // take the twin with it — the cascade matches on product_variant_id +
    // variant, so a sloppy delete would remove both.
    const rfq_id = await makeEditableRfq();
    const twinA = await attachOneProduct(rfq_id, 7, 0);
    const twinB = await attachOneProduct(rfq_id, 7, 1);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== twinB);
    payload.deleted_product_ids = [twinB];

    expect((await update(rfq_id, payload)).status).toBe(200);
    expect(await productIds(rfq_id)).toEqual([twinA]);

    const survivingSpecs = await db.any(
      `SELECT title FROM tbl_rfq_products_specs
        WHERE rfq_id=$1 AND product_variant_id=7 AND variant=0 ORDER BY title`,
      [rfq_id]
    );
    expect(survivingSpecs.map((s) => s.title)).toEqual(["Quantity", "Unit"]);
  });

  it("adds one product and removes another in the same save", async () => {
    const rfq_id = await makeEditableRfq();
    const keep = await attachOneProduct(rfq_id, 1);
    const drop = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== drop);
    payload.products.push({
      id: null,
      product_variant_id: 3,
      variant: 0,
      product_name: "replacement",
      comment: "",
      specs: { Quantity: "5", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });
    payload.deleted_product_ids = [drop];

    expect((await update(rfq_id, payload)).status).toBe(200);

    const after = await db.any(
      `SELECT product_variant_id FROM tbl_rfq_products WHERE rfq_id=$1 ORDER BY product_variant_id`,
      [rfq_id]
    );
    expect(after.map((r) => Number(r.product_variant_id))).toEqual([1, 3]);
    expect(await productIds(rfq_id)).toContain(keep);
  });
});

// ===========================================================================
//  Implicit removal — refused
// ===========================================================================

describe("rfqController.update — a product missing from the snapshot is never deleted", () => {
  it("refuses the update with 409 when a product is omitted without being marked for removal", async () => {
    // This is the RFQ 536245 data-loss path. Before the fix this call silently
    // cascade-deleted the product and everything hanging off it.
    const rfq_id = await makeEditableRfq();
    const keep = await attachOneProduct(rfq_id, 1);
    const ghost = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== ghost);
    payload.deleted_product_ids = [];

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(409);
    expect(await productIds(rfq_id)).toEqual([keep, ghost].sort((a, b) => a - b));
  });

  it("leaves no DELETE history behind when it refuses", async () => {
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const ghost = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== ghost);
    payload.deleted_product_ids = [];

    await update(rfq_id, payload);

    expect(await deleteHistory(rfq_id)).toEqual([]);
  });

  it("refuses when the snapshot omits deleted_product_ids entirely", async () => {
    // An older client, or a hand-rolled request. Silence is not consent.
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const ghost = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== ghost);
    delete payload.deleted_product_ids;

    expect((await update(rfq_id, payload)).status).toBe(409);
    expect(await productIds(rfq_id)).toContain(ghost);
  });

  it("names the product the buyer would have lost", async () => {
    // The message is what the buyer sees in the toast, so it has to say which
    // product and what to do about it.
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const ghost = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== ghost);
    payload.deleted_product_ids = [];

    const calls = await update(rfq_id, payload);

    expect(calls.body.message).toMatch(/refresh/i);
  });

  it("rolls back the whole save, including the RFQ field edits it came with", async () => {
    // Atomicity: the buyer must not end up with the date change applied and
    // the product silently gone.
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);
    const ghost = await attachOneProduct(rfq_id, 2);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = payload.products.filter((p) => Number(p.id) !== ghost);
    payload.deleted_product_ids = [];
    payload.comment = "this must not stick";

    await update(rfq_id, payload);

    const after = await db.one(`SELECT comment FROM tbl_rfq WHERE id=$1`, [rfq_id]);
    expect(after.comment).toBe("initial comment");
  });

  it("survives the concurrent-save race that destroyed products on RFQ 536245", async () => {
    // Two tabs, one stale. The stale snapshot was built before the second
    // product existed, so it neither lists nor deletes it. Under the old
    // omission-means-delete rule this wiped the product; now it is refused and
    // the buyer is told to refresh.
    const rfq_id = await makeEditableRfq();
    const first = await attachOneProduct(rfq_id, 1);

    // Tab A reads the RFQ while it has one product.
    const staleSnap = JSON.parse(JSON.stringify(await fetchSnapshot(rfq_id)));

    // Tab B adds a second product and saves.
    const freshSnap = JSON.parse(JSON.stringify(await fetchSnapshot(rfq_id)));
    freshSnap.deleted_product_ids = [];
    freshSnap.products.push({
      id: null,
      product_variant_id: 2,
      variant: 0,
      product_name: "added by the other tab",
      comment: "",
      specs: { Quantity: "5", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });
    expect((await update(rfq_id, freshSnap)).status).toBe(200);
    const bothProducts = await productIds(rfq_id);
    expect(bothProducts).toHaveLength(2);

    // Tab A now saves its stale snapshot — an unrelated comment edit.
    staleSnap.deleted_product_ids = [];
    staleSnap.comment = "tab A edit";
    const calls = await update(rfq_id, staleSnap);

    expect(calls.status).toBe(409);
    expect(await productIds(rfq_id)).toEqual(bothProducts);
    expect(await productIds(rfq_id)).toContain(first);
  });
});

describe("rfqController.update — a burst of overlapping saves cannot destroy products", () => {
  it("keeps every pre-existing product when four saves land at once", async () => {
    // The literal RFQ 536245 burst: four requests inside six seconds, none of
    // which had seen the others' writes. Under the old omission-means-delete
    // rule the last one to commit deleted whatever the earlier ones had
    // created. The frontend save gate stops the burst at source; this asserts
    // the server no longer loses data even when it does not.
    //
    // Interleaving is nondeterministic, so the assertion is the invariant that
    // must hold under every ordering: nothing that existed before the burst is
    // gone afterwards.
    const rfq_id = await makeEditableRfq();
    const before = [
      await attachOneProduct(rfq_id, 1),
      await attachOneProduct(rfq_id, 2),
      await attachOneProduct(rfq_id, 3),
    ];

    const snap = JSON.parse(JSON.stringify(await fetchSnapshot(rfq_id)));

    const burst = [0, 1, 2, 3].map((n) => {
      const payload = JSON.parse(JSON.stringify(snap));
      payload.deleted_product_ids = [];
      payload.comment = `burst save ${n}`;
      return update(rfq_id, payload);
    });
    await Promise.all(burst);

    const after = await productIds(rfq_id);
    for (const id of before) expect(after).toContain(id);
  });

  it("keeps every product when the burst is built from a snapshot taken before an add", async () => {
    // The nastiest ordering: one tab adds a product, another tab's queued saves
    // still describe the RFQ without it. Those saves must fail rather than
    // delete the new product.
    const rfq_id = await makeEditableRfq();
    const original = await attachOneProduct(rfq_id, 1);

    const staleSnap = JSON.parse(JSON.stringify(await fetchSnapshot(rfq_id)));

    const addSnap = JSON.parse(JSON.stringify(staleSnap));
    addSnap.deleted_product_ids = [];
    addSnap.products.push({
      id: null,
      product_variant_id: 2,
      variant: 0,
      product_name: "the product the stale saves never saw",
      comment: "",
      specs: { Quantity: "5", Unit: "NOS" },
      files: { qap_file: [], spec_file: [], datasheet_file: [] },
      vendors: [],
      tech_eval_clauses: [],
    });
    expect((await update(rfq_id, addSnap)).status).toBe(200);
    const afterAdd = await productIds(rfq_id);
    expect(afterAdd).toHaveLength(2);

    await Promise.all(
      [0, 1, 2].map((n) => {
        const payload = JSON.parse(JSON.stringify(staleSnap));
        payload.deleted_product_ids = [];
        payload.comment = `stale save ${n}`;
        return update(rfq_id, payload);
      })
    );

    expect(await productIds(rfq_id)).toEqual(afterAdd);
    expect(await productIds(rfq_id)).toContain(original);
    expect(await deleteHistory(rfq_id)).toEqual([]);
  });
});

// ===========================================================================
//  Contradictory and stale instructions
// ===========================================================================

describe("rfqController.update — deleted_product_ids validation", () => {
  it("rejects a snapshot that both keeps and deletes the same product", async () => {
    // Contradictory intent. Picking a winner silently is how the original bug
    // stayed invisible for four months.
    const rfq_id = await makeEditableRfq();
    const p1 = await attachOneProduct(rfq_id, 1);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.deleted_product_ids = [p1];

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(400);
    expect(await productIds(rfq_id)).toEqual([p1]);
  });

  it("ignores an id that is already gone so a retry succeeds", async () => {
    // The buyer's first attempt 409'd, they refreshed, and their client still
    // remembers the removal. The product is already absent — that is the
    // desired end state, so the save proceeds.
    const rfq_id = await makeEditableRfq();
    const keep = await attachOneProduct(rfq_id, 1);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.deleted_product_ids = [999999];
    payload.comment = "retry after refresh";

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(200);
    expect(await productIds(rfq_id)).toEqual([keep]);
  });

  it("does not treat an empty deleted_product_ids as a change on its own", async () => {
    // Every save from the fixed client carries the key. A save that changes
    // nothing else must still be a no-op, not a spurious edit-history entry.
    const rfq_id = await makeEditableRfq();
    await attachOneProduct(rfq_id, 1);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.deleted_product_ids = [];

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(200);
    expect(calls.body.change_count).toBe(0);
  });

  it("refuses to delete every product on the RFQ", async () => {
    // An RFQ with no products is not a thing the rest of the system can
    // handle; the frontend blocks it and the server must not rely on that.
    const rfq_id = await makeEditableRfq();
    const only = await attachOneProduct(rfq_id, 1);

    const snap = await fetchSnapshot(rfq_id);
    const payload = JSON.parse(JSON.stringify(snap));
    payload.products = [];
    payload.deleted_product_ids = [only];

    const calls = await update(rfq_id, payload);

    expect(calls.status).toBe(400);
    expect(await productIds(rfq_id)).toEqual([only]);
  });
});
