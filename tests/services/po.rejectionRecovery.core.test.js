// REQ-0032 — a vendor rejected a PO by mistake. Recovery core.
//
// app/services/po/poRejectionRecovery.js decides whether a vendor-rejected PO
// can be put back exactly as it was (findRecoveryBlockers), how long the
// vendor's own undo stays open (undoWindow), and puts the award back
// (restoreAward). The vendor "accept instead" and buyer "send back" flows are
// built on top of it.
//
// Every case starts from a REAL rejection: the PO is rejected through the
// production rejectPO handler, so the de-finalization cascade, the cancelled
// NEGOTIATION_QUOTE instance and (for call-offs) the released contract
// quantity are whatever production actually leaves behind.
//
// Also locked in: acceptPO and rejectPO take the PO row lock, so a vendor's
// concurrent accept and reject cannot both succeed.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { poFixtures, newPoFixtureTracker, cleanupPoFixtures } from "../helpers/poFixtures.js";

// ---- Post-commit work ------------------------------------------------------
//
// acceptPO / rejectPO answer first and notify afterwards without awaiting
// (sendPONotificationToVendor, sendPOAcceptedNotificationToTeam,
// sendVendorRejectionNotification), and those in turn fire dispatchNotification
// without awaiting. Left alone, that work races this suite's cleanup and
// outlives closeDb() (pg-promise's end() shuts every pool in the process, the
// app's included). The real functions still run; they are only wrapped so the
// suite can wait for them. Registration order matters: notificationService is
// mocked BEFORE the real purchaseOrderEmails is loaded, so that module binds to
// the tracked dispatch, and both are mocked before the controller is loaded.
const pending = new Set();
const track = (fn) => (...args) => {
  const p = Promise.resolve().then(() => fn(...args));
  pending.add(p);
  p.then(() => pending.delete(p), () => pending.delete(p));
  return p;
};
async function drainPostCommitWork() {
  while (pending.size) await Promise.allSettled([...pending]);
}

const actualNotifications = await import("../../app/services/notificationService.js");
jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
  ...actualNotifications,
  dispatch: track(actualNotifications.dispatch),
}));
const actualPoEmails = await import("../../app/controllers/po/purchaseOrderEmails.js");
jest.unstable_mockModule("../../app/controllers/po/purchaseOrderEmails.js", () => ({
  ...actualPoEmails,
  sendPONotificationToVendor: track(actualPoEmails.sendPONotificationToVendor),
  sendPOAcceptedNotificationToTeam: track(actualPoEmails.sendPOAcceptedNotificationToTeam),
  sendVendorRejectionNotification: track(actualPoEmails.sendVendorRejectionNotification),
}));

const poController = await import("../../app/controllers/po/purchaseOrderController.js");
const recovery = await import("../../app/services/po/poRejectionRecovery.js");

const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;
const BUYER = IDS.users.a1_proc_buyer;
const HOUR = 3600_000;

afterAll(async () => {
  await drainPostCommitWork();
  await closeDb();
});

// Notifications are keyed by entity in additional_data; delete only this suite's.
async function deleteNotificationsFor({ poIds = [], mrIds = [] }) {
  if (!poIds.length && !mrIds.length) return;
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE (additional_data->>'po_id') = ANY($1::text[])
         OR (additional_data->>'mr_id') = ANY($2::text[])`,
    [poIds.map(String), mrIds.map(String)]
  );
}

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

const inserted = newPoFixtureTracker();
const { makeRfqWithProductAndVendor, makeFinalization, makePo, attachProductToPo } = poFixtures(inserted);

afterEach(async () => {
  await drainPostCommitWork();
  await deleteNotificationsFor({ poIds: inserted.poIds });
  const rfqIds = inserted.rfqIds;
  const rpIds = inserted.rfqProductIds;
  if (rpIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
          WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($1::int[]))`,
      [rpIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($1::int[])`,
      [rpIds]
    );
  }
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(
      `DELETE FROM tbl_rfq_product_tech_evaluation_cleared_vendors
        WHERE tbl_rfq_product_tech_evaluation_id IN (
          SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`,
      [rfqIds]
    );
    await db.none(`DELETE FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  }
  await cleanupPoFixtures(inserted);
});

// ---- Setup helpers ---------------------------------------------------------

async function addProduct(rfq_id, productVariantId, vendorId = ALPHA) {
  const p = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, productVariantId]
  );
  inserted.rfqProductIds.push(p.id);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, productVariantId, vendorId]
  );
  return p.id;
}

async function addQuote(rfq_id, vendorId) {
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, 1, $2, $2) RETURNING id`,
    [rfq_id, vendorId]
  );
  inserted.quoteIds.push(q.id);
  return q.id;
}

/** A NEGOTIATION_QUOTE (award) approval instance with one step. */
async function insertNq(rfq_product_id, status, { stepStatus } = {}) {
  const step = stepStatus || (status === "PENDING" ? "PENDING" : "APPROVED");
  const row = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, department_id, process_id, completed_at)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, $3, 1, $4, $5, $6, $7, $8,
             CASE WHEN $3 = 'PENDING' THEN NULL ELSE LOCALTIMESTAMP END)
     RETURNING id`,
    [
      rfq_product_id, IDS.policies.A1_P1_NEGOTIATION_QUOTE, status, BUYER,
      IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1,
    ]
  );
  await db.none(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status)
     VALUES ($1, 1, $2)`,
    [row.id, step]
  );
  return row.id;
}

/**
 * An awarded RFQ PO awaiting the vendor: one finalization + one APPROVED
 * NEGOTIATION_QUOTE instance per product, one PO line per product.
 * `beforePo(base)` runs just before the PO is created (to place an OLDER PO).
 */
async function awardedPo({ vendorId = ALPHA, productVariantIds = [1], beforePo = null } = {}) {
  const base = await makeRfqWithProductAndVendor({ vendorId, productVariantId: productVariantIds[0] });
  const lines = [{ rfq_product_id: base.rfq_product_id, product_variant_id: productVariantIds[0] }];
  for (const pv of productVariantIds.slice(1)) {
    lines.push({ rfq_product_id: await addProduct(base.rfq_id, pv, vendorId), product_variant_id: pv });
  }
  const finalizationIds = [];
  const nqIds = [];
  for (const l of lines) {
    finalizationIds.push(await makeFinalization(base.rfq_id, l.product_variant_id, vendorId, base.quote_id));
    nqIds.push(await insertNq(l.rfq_product_id, "APPROVED"));
  }
  if (beforePo) await beforePo(base);
  const po_id = await makePo({
    rfq_id: base.rfq_id, vendorId,
    rfq_product_ids: lines.map((l) => l.rfq_product_id),
    quote_ids: lines.map(() => base.quote_id),
  });
  for (const l of lines) await attachProductToPo(po_id, l.rfq_product_id, base.quote_id);
  return { ...base, lines, finalizationIds, nqIds, po_id };
}

async function vendorRejects(po_id, vendorId = ALPHA, reason = "Ordered the wrong item") {
  const m = mockExpress({ user: { id: vendorId }, params: { po_id: String(po_id) }, body: { reason } });
  await poController.rejectPO(m.req, m.res);
  expect(m.calls.body).toMatchObject({ status: 1 });
}

async function rejectedPo(opts = {}) {
  const s = await awardedPo(opts);
  await vendorRejects(s.po_id, opts.vendorId ?? ALPHA);
  return s;
}

const readPo = (po_id) => db.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);

const blockersFor = (po_id) =>
  db.tx(async (t) => recovery.findRecoveryBlockers(t, await recovery.lockPo(t, po_id)));

// restoreAward must be safe on its own: hand it a plain, unlocked, possibly
// stale read of the PO, the way a careless caller would.
const restore = async (po_id, actor = BUYER) => {
  const stale = await readPo(po_id);
  return db.tx((t) => recovery.restoreAward(t, stale, actor));
};

const liveFinalizations = (rfq_id) =>
  db.any(
    `SELECT vendor_id, product_variant_id FROM tbl_quote_finalization
      WHERE rfq_id = $1 ORDER BY product_variant_id, vendor_id`,
    [rfq_id]
  );

const nqStatus = async (id) =>
  (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;

const { BLOCKERS } = recovery;

// ===========================================================================
//  Guards — RFQ PO
// ===========================================================================

describe("findRecoveryBlockers — RFQ PO", () => {
  it("findRecoveryBlockers is empty right after a vendor rejection", async () => {
    const s = await rejectedPo();

    // The state is the one rejectPO really leaves behind.
    const po = await db.tx((t) => recovery.lockPo(t, s.po_id));
    expect(po.status).toBe("rejected_by_vendor");
    expect(await liveFinalizations(s.rfq_id)).toEqual([]);
    expect(await nqStatus(s.nqIds[0])).toBe("CANCELLED");
    // ...including the post-commit notice to the evaluators (tracked, see top).
    await drainPostCommitWork();
    const notice = await db.oneOrNone(
      `SELECT 1 FROM tbl_notifications
        WHERE type = 'po_vendor_rejected' AND (additional_data->>'po_id') = $1 LIMIT 1`,
      [String(s.po_id)]
    );
    expect(notice).not.toBeNull();

    expect(await blockersFor(s.po_id)).toEqual([]);
  });

  it("reports only NOT_REJECTED_BY_VENDOR for a PO the vendor has not rejected, even when other guards would fire", async () => {
    const s = await awardedPo();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [s.rfq_id]);
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.NOT_REJECTED_BY_VENDOR]);
  });

  it("lockPo returns null for an unknown or malformed id", async () => {
    expect(await db.tx((t) => recovery.lockPo(t, 999999999))).toBeNull();
    expect(await db.tx((t) => recovery.lockPo(t, "12; DROP TABLE x"))).toBeNull();
  });

  it("reports PRODUCT_REAWARDED when another vendor was finalized after the rejection", async () => {
    const s = await rejectedPo();
    const betaQuote = await addQuote(s.rfq_id, BETA);
    await makeFinalization(s.rfq_id, s.product_variant_id, BETA, betaQuote);
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.PRODUCT_REAWARDED]);
  });

  it("reports REPLACEMENT_PO_EXISTS for a newer draft PO on the same product", async () => {
    // An OLDER dead PO on the product is not a replacement.
    const s = await rejectedPo({
      beforePo: async ({ rfq_id, rfq_product_id, quote_id }) => {
        const older = await makePo({
          rfq_id, status: "cancelled", rfq_product_ids: [rfq_product_id], quote_ids: [quote_id],
        });
        await attachProductToPo(older, rfq_product_id, quote_id);
      },
    });
    expect(await blockersFor(s.po_id)).toEqual([]);

    const draft = await makePo({
      rfq_id: s.rfq_id, status: "draft", rfq_product_ids: [s.rfq_product_id], quote_ids: [s.quote_id],
    });
    await attachProductToPo(draft, s.rfq_product_id, s.quote_id);
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.REPLACEMENT_PO_EXISTS]);
  });

  it("reports AWARD_APPROVAL_PENDING for a pending NEGOTIATION_QUOTE instance", async () => {
    const s = await rejectedPo();
    await insertNq(s.rfq_product_id, "PENDING");
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.AWARD_APPROVAL_PENDING]);
  });

  it("reports NEGOTIATION_IN_PROGRESS for an ACTIVE round and for a PENDING_APPROVAL round covering the product", async () => {
    const s = await rejectedPo();
    // end_date is a naive column holding UTC wall clock (see the finalize guard).
    const insertRound = ({ status, endsIn, legacy }) =>
      db.one(
        `INSERT INTO tbl_negotiation_rounds
           (rfq_id, round_number, end_date, status, created_by, rfq_product_id,
            vendor_ids, source_type, source_id, products)
         VALUES ($1, 1, (now() AT TIME ZONE 'UTC') + $2::interval, $3, $4, $5,
                 ARRAY[$6]::int[], 'RFQ', $1, $7::jsonb)
         RETURNING id`,
        [
          s.rfq_id, endsIn, status, BUYER,
          legacy ? s.rfq_product_id : null,
          ALPHA,
          legacy ? null : JSON.stringify([{ rfq_product_id: s.rfq_product_id, vendor_targets: [] }]),
        ]
      );

    // An ACTIVE round whose window has closed is not in progress.
    const ended = await insertRound({ status: "ACTIVE", endsIn: "-1 hour", legacy: true });
    expect(await blockersFor(s.po_id)).toEqual([]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = $1`, [ended.id]);

    // One hour left: open under a UTC session AND an IST one.
    const active = await insertRound({ status: "ACTIVE", endsIn: "1 hour", legacy: true });
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.NEGOTIATION_IN_PROGRESS]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = $1`, [active.id]);

    // Multi-product shape (coverage in the products JSONB), awaiting approval.
    await insertRound({ status: "PENDING_APPROVAL", endsIn: "2 days", legacy: false });
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.NEGOTIATION_IN_PROGRESS]);
  });

  it("reports RFQ_CLOSED when the RFQ status is 2", async () => {
    const s = await rejectedPo();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [s.rfq_id]);
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.RFQ_CLOSED]);
  });

  it("reports VENDOR_NOT_QUALIFIED when the vendor failed the product's technical evaluation", async () => {
    const s = await rejectedPo();
    const te = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id, minimum_passing_score)
       VALUES ($1, $2, 50) RETURNING id`,
      [s.rfq_id, s.rfq_product_id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status, created_by, calculated_score)
       VALUES ($1, $2, 0, $3, 20)`,
      [te.id, ALPHA, BUYER]
    );
    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.VENDOR_NOT_QUALIFIED]);
  });

  it("returns every blocker that applies, in the documented order", async () => {
    const s = await rejectedPo();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [s.rfq_id]);
    const betaQuote = await addQuote(s.rfq_id, BETA);
    await makeFinalization(s.rfq_id, s.product_variant_id, BETA, betaQuote);
    const draft = await makePo({
      rfq_id: s.rfq_id, vendorId: BETA, status: "draft", rfq_product_ids: [s.rfq_product_id], quote_ids: [betaQuote],
    });
    await attachProductToPo(draft, s.rfq_product_id, betaQuote);
    await insertNq(s.rfq_product_id, "PENDING");
    await db.none(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, round_number, end_date, status, created_by, rfq_product_id, source_type, source_id)
       VALUES ($1, 2, (now() AT TIME ZONE 'UTC') + interval '1 day', 'PENDING_APPROVAL', $2, $3, 'RFQ', $1)`,
      [s.rfq_id, BUYER, s.rfq_product_id]
    );
    const te = await db.one(
      `INSERT INTO tbl_rfq_product_tech_evaluation (rfq_id, tbl_rfq_product_id) VALUES ($1, $2) RETURNING id`,
      [s.rfq_id, s.rfq_product_id]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_tech_evaluation_cleared_vendors
         (tbl_rfq_product_tech_evaluation_id, vendor_id, status) VALUES ($1, $2, 0)`,
      [te.id, ALPHA]
    );
    // A history trail that predates the vendor-rejection record.
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [s.rfq_id]);

    expect(await blockersFor(s.po_id)).toEqual([
      BLOCKERS.RFQ_CLOSED,
      BLOCKERS.PRODUCT_REAWARDED,
      BLOCKERS.REPLACEMENT_PO_EXISTS,
      BLOCKERS.AWARD_APPROVAL_PENDING,
      BLOCKERS.NEGOTIATION_IN_PROGRESS,
      BLOCKERS.VENDOR_NOT_QUALIFIED,
      BLOCKERS.AWARD_HISTORY_MISSING,
    ]);
  });
});

// ===========================================================================
//  restoreAward — RFQ PO
// ===========================================================================

describe("restoreAward — RFQ PO", () => {
  it("restoreAward re-creates the vendor's finalization rows and re-approves the cancelled NEGOTIATION_QUOTE instance", async () => {
    const s = await awardedPo();
    const original = await db.one(
      `SELECT rfq_no, quote_id, created_by, variant, "timestamp" AS ts FROM tbl_quote_finalization WHERE id = $1`,
      [s.finalizationIds[0]]
    );
    await vendorRejects(s.po_id);
    const cancelled = await db.one(
      `SELECT status, completed_at FROM tbl_approval_instances WHERE id = $1`, [s.nqIds[0]]
    );
    expect(cancelled.status).toBe("CANCELLED");

    await restore(s.po_id);

    const live = await db.any(
      `SELECT rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant, comment, "timestamp" AS ts
         FROM tbl_quote_finalization WHERE rfq_id = $1`,
      [s.rfq_id]
    );
    expect(live).toEqual([{
      rfq_no: original.rfq_no,
      quote_id: original.quote_id,
      product_variant_id: s.product_variant_id,
      vendor_id: ALPHA,
      created_by: original.created_by,
      variant: original.variant,
      comment: null,
      ts: original.ts, // the award keeps its original finalization time
    }]);

    const nq = await db.one(`SELECT status, completed_at FROM tbl_approval_instances WHERE id = $1`, [s.nqIds[0]]);
    expect(nq.status).toBe("APPROVED");
    expect(nq.completed_at).toBe(cancelled.completed_at);

    // restoreAward restores the award only; the PO's own status is the caller's job.
    expect((await readPo(s.po_id)).status).toBe("rejected_by_vendor");
  });

  it("re-checks its guards under the row lock: a second restore is refused and duplicates nothing", async () => {
    const s = await rejectedPo();
    await restore(s.po_id);

    const second = restore(s.po_id);
    await expect(second).rejects.toBeInstanceOf(recovery.RecoveryError);
    await expect(second).rejects.toMatchObject({ status: 409, code: BLOCKERS.PRODUCT_REAWARDED });
    expect(await liveFinalizations(s.rfq_id)).toEqual([{ vendor_id: ALPHA, product_variant_id: 1 }]);
  });

  it("an older rejected PO is not restored with a newer award's history; only the newest rejected PO is restorable", async () => {
    // V rejects PO1 -> the buyer re-awards the product to V on a fresh quote ->
    // PO2 -> V rejects PO2. Both POs are now rejected_by_vendor, and the latest
    // history row is PO2's.
    const s = await rejectedPo();
    const quote2 = await addQuote(s.rfq_id, ALPHA);
    await makeFinalization(s.rfq_id, s.product_variant_id, ALPHA, quote2);
    const nq2 = await insertNq(s.rfq_product_id, "APPROVED");
    const po2 = await makePo({
      rfq_id: s.rfq_id, rfq_product_ids: [s.rfq_product_id], quote_ids: [quote2],
    });
    await attachProductToPo(po2, s.rfq_product_id, quote2);
    await vendorRejects(po2);
    expect(await nqStatus(nq2)).toBe("CANCELLED");

    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.REPLACEMENT_PO_EXISTS]);
    await expect(restore(s.po_id)).rejects.toMatchObject({ status: 409, code: BLOCKERS.REPLACEMENT_PO_EXISTS });
    expect(await liveFinalizations(s.rfq_id)).toEqual([]);
    expect(await nqStatus(s.nqIds[0])).toBe("CANCELLED");
    expect(await nqStatus(nq2)).toBe("CANCELLED");

    expect(await blockersFor(po2)).toEqual([]);
    await restore(po2);
    expect(await db.any(`SELECT vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [s.rfq_id]))
      .toEqual([{ vendor_id: ALPHA, quote_id: quote2 }]);
    expect(await nqStatus(nq2)).toBe("APPROVED");
    expect(await nqStatus(s.nqIds[0])).toBe("CANCELLED");
  });

  it("multi-product PO with one product re-awarded is blocked as a whole", async () => {
    const s = await rejectedPo({ productVariantIds: [1, 2] });
    const betaQuote = await addQuote(s.rfq_id, BETA);
    await makeFinalization(s.rfq_id, 2, BETA, betaQuote);

    expect(await blockersFor(s.po_id)).toEqual([BLOCKERS.PRODUCT_REAWARDED]);
    await expect(restore(s.po_id)).rejects.toMatchObject({ status: 409, code: BLOCKERS.PRODUCT_REAWARDED });

    // Never partial: the product nobody touched is not restored on its own.
    expect(await liveFinalizations(s.rfq_id)).toEqual([{ vendor_id: BETA, product_variant_id: 2 }]);
    expect(await nqStatus(s.nqIds[0])).toBe("CANCELLED");
  });

  it("restoreAward on a multi-vendor PO restores only this vendor's rows (the F-PO-CASCADE-001 mirror)", async () => {
    // One product split between two vendors under one batched award approval,
    // one PO each (Beta's raised first). Both vendors reject; only Alpha's
    // award comes back.
    const base = await makeRfqWithProductAndVendor({ vendorId: ALPHA });
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, 1, $2, 0)`,
      [base.rfq_id, BETA]
    );
    const betaQuote = await addQuote(base.rfq_id, BETA);
    await makeFinalization(base.rfq_id, 1, ALPHA, base.quote_id);
    await makeFinalization(base.rfq_id, 1, BETA, betaQuote);
    const nq = await insertNq(base.rfq_product_id, "APPROVED");
    const betaPo = await makePo({
      rfq_id: base.rfq_id, vendorId: BETA, rfq_product_ids: [base.rfq_product_id], quote_ids: [betaQuote],
    });
    await attachProductToPo(betaPo, base.rfq_product_id, betaQuote);
    const alphaPo = await makePo({
      rfq_id: base.rfq_id, vendorId: ALPHA, rfq_product_ids: [base.rfq_product_id], quote_ids: [base.quote_id],
    });
    await attachProductToPo(alphaPo, base.rfq_product_id, base.quote_id);

    await vendorRejects(betaPo, BETA);
    expect(await nqStatus(nq)).toBe("APPROVED"); // Alpha still holds the award
    await vendorRejects(alphaPo, ALPHA);
    expect(await nqStatus(nq)).toBe("CANCELLED");

    // A newer PO on the product, whatever its status, means it moved on.
    expect(await blockersFor(betaPo)).toEqual([BLOCKERS.REPLACEMENT_PO_EXISTS]);
    expect(await blockersFor(alphaPo)).toEqual([]);
    await restore(alphaPo);

    expect(await liveFinalizations(base.rfq_id)).toEqual([{ vendor_id: ALPHA, product_variant_id: 1 }]);
    expect(await nqStatus(nq)).toBe("APPROVED");
    const hist = await db.any(
      `SELECT vendor_id FROM tbl_quote_finalization_history WHERE rfq_id = $1 ORDER BY vendor_id`, [base.rfq_id]
    );
    expect(hist.map((h) => h.vendor_id)).toEqual([ALPHA, BETA]); // the trail is kept
    expect((await readPo(betaPo)).status).toBe("rejected_by_vendor");
    // Beta now also finds the product held by Alpha again.
    expect(await blockersFor(betaPo)).toEqual([BLOCKERS.PRODUCT_REAWARDED, BLOCKERS.REPLACEMENT_PO_EXISTS]);
  });

  it("a PO carrying another vendor's line (the F-PO-CASCADE-001 shape) is refused as a whole and leaves that vendor's row alone", async () => {
    const { rfq_id, rfq_product_id: productA, quote_id } = await makeRfqWithProductAndVendor({ vendorId: ALPHA });
    const productB = await addProduct(rfq_id, 2, BETA);
    const quoteB = await addQuote(rfq_id, BETA);
    await makeFinalization(rfq_id, 1, ALPHA, quote_id);
    await makeFinalization(rfq_id, 2, BETA, quoteB);
    const po_id = await makePo({
      rfq_id, vendorId: ALPHA, rfq_product_ids: [productA, productB], quote_ids: [quote_id, quoteB],
    });
    await attachProductToPo(po_id, productA, quote_id);
    await attachProductToPo(po_id, productB, quoteB);
    await vendorRejects(po_id, ALPHA);

    expect(await blockersFor(po_id)).toEqual([BLOCKERS.PRODUCT_REAWARDED, BLOCKERS.AWARD_HISTORY_MISSING]);
    await expect(restore(po_id)).rejects.toMatchObject({ status: 409, code: BLOCKERS.PRODUCT_REAWARDED });
    expect(await liveFinalizations(rfq_id)).toEqual([{ vendor_id: BETA, product_variant_id: 2 }]);
  });

  it("never turns a never-approved NEGOTIATION_QUOTE request into an approval", async () => {
    const s = await rejectedPo();
    // After the rejection the buyer opened a new award request and withdrew it
    // before anyone approved it.
    const withdrawn = await insertNq(s.rfq_product_id, "CANCELLED", { stepStatus: "CANCELLED" });

    expect(await blockersFor(s.po_id)).toEqual([]);
    await restore(s.po_id);

    expect(await liveFinalizations(s.rfq_id)).toEqual([{ vendor_id: ALPHA, product_variant_id: 1 }]);
    expect(await nqStatus(withdrawn)).toBe("CANCELLED");
  });
});

// ===========================================================================
//  undoWindow
// ===========================================================================

describe("undoWindow", () => {
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const near = (iso, expectedMs) => Math.abs(Date.parse(iso) - expectedMs) < 2 * 60_000;

  it("undoWindow is open at 23h and closed at 25h", async () => {
    const s = await awardedPo();
    // Not rejected yet: no vendor action, no window.
    expect(await recovery.undoWindow(db, await readPo(s.po_id))).toEqual({ open: false, deadline: null });

    await vendorRejects(s.po_id);
    let w = await recovery.undoWindow(db, await readPo(s.po_id));
    expect(w.open).toBe(true);
    expect(w.deadline).toMatch(ISO_INSTANT);
    expect(near(w.deadline, Date.now() + 24 * HOUR)).toBe(true);

    await db.none(
      `UPDATE tbl_rfq_purchase_order SET vendor_action_at = LOCALTIMESTAMP - INTERVAL '23 hours' WHERE id = $1`,
      [s.po_id]
    );
    w = await recovery.undoWindow(db, await readPo(s.po_id));
    expect(w.open).toBe(true);
    expect(w.deadline).toMatch(ISO_INSTANT);
    expect(near(w.deadline, Date.now() + HOUR)).toBe(true);

    await db.none(
      `UPDATE tbl_rfq_purchase_order SET vendor_action_at = LOCALTIMESTAMP - INTERVAL '25 hours' WHERE id = $1`,
      [s.po_id]
    );
    w = await recovery.undoWindow(db, await readPo(s.po_id));
    expect(w.open).toBe(false);
    expect(w.deadline).toMatch(ISO_INSTANT);
    expect(near(w.deadline, Date.now() - HOUR)).toBe(true);
  });
});

// ===========================================================================
//  Call-off POs
// ===========================================================================

describe("call-off PO recovery", () => {
  const HC = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const PROC = IDS.processes.A_P1;
  const VENDOR = ALPHA;
  const VARIANT_ID = 1;
  let arcId, contractId, contractLineId, handleMrPostApproval;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-RRCORE-1','Rejection recovery ARC',$1,$2,$3,$4,$5,'contract_active',
               NOW()-INTERVAL '30 days', NOW()-INTERVAL '20 days',
               NOW()-INTERVAL '10 days', NOW()+INTERVAL '180 days', $6) RETURNING id`,
      [TEST_CATEGORIES.beverages, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1,$2,1000,'litre') RETURNING id`, [arcId, VARIANT_ID]
    );
    contractId = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [arcId, VENDOR]
    )).id;
    contractLineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1,$2,90,5,1000) RETURNING id`, [contractId, item.id]
    )).id;
    // The ordering hotel's ledger row, so the hotel-level usage is exercised too.
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
       VALUES ($1, $2, 1000)`,
      [contractLineId, HOTEL]
    );
    ({ handleMrPostApproval } = await import("../../app/controllers/mr/mrController.js"));
  });

  beforeEach(async () => {
    await db.none(`UPDATE tbl_arc_contract SET status = 'active' WHERE id = $1`, [contractId]);
  });

  afterAll(async () => {
    await drainPostCommitWork();
    const poIds = (await db.any(
      `SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id = $1`, [contractId]
    )).map((r) => r.id);
    const mrIds = (await db.any(
      `SELECT id FROM tbl_material_requisition WHERE hospitality_company_id = $1 AND title LIKE 'RRCORE%'`, [HC]
    )).map((r) => r.id);
    await deleteNotificationsFor({ poIds, mrIds });
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    }
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1)`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_material_requisition WHERE hospitality_company_id=$1 AND title LIKE 'RRCORE%'`, [HC]);
    await db.none(`DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id=$1`, [contractLineId]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id=$1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id=$1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id=$1`, [arcId]);
  });

  // The releaseOne setup from arc_v2/mr.calloff.acceptance.test.js: release a
  // call-off PO for a fresh MR through the real MR post-approval hook.
  async function releaseOne(tag, qty, instId, { reset = true } = {}) {
    if (reset) {
      await db.none(`UPDATE tbl_arc_contract_line SET consumed_qty=0 WHERE id=$1`, [contractLineId]);
      await db.none(`UPDATE tbl_arc_contract_line_hotel SET consumed_qty=0 WHERE arc_contract_line_id=$1`, [contractLineId]);
    }
    const mr = await db.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,'normal',$6,'pending_approval',NOW()) RETURNING *`,
      [`MR-RRCORE-${tag}`, `RRCORE ${tag}`, HC, HOTEL, DEPT, BUYER]
    );
    await db.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1,$2,$3,'litre',$4,$5,90)`, [mr.id, VARIANT_ID, qty, contractId, contractLineId]
    );
    await handleMrPostApproval(instId, BUYER, {
      instance: { id: instId, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
    });
    const poId = (await db.one(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id=$1`, [mr.id])).po_id;
    return { mrId: mr.id, poId };
  }

  const consumed = async () => ({
    line: Number((await db.one(`SELECT consumed_qty FROM tbl_arc_contract_line WHERE id=$1`, [contractLineId])).consumed_qty),
    hotel: Number((await db.one(
      `SELECT consumed_qty FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id=$1 AND hotel_id=$2`,
      [contractLineId, HOTEL]
    )).consumed_qty),
  });
  const mrStatus = async (mrId) =>
    (await db.one(`SELECT status FROM tbl_material_requisition WHERE id=$1`, [mrId])).status;

  it("call-off restore re-consumes the contract quantity and sets the MR back to po_released without duplicating link rows", async () => {
    const { mrId, poId } = await releaseOne("restore", 150, 71001);
    expect(await consumed()).toEqual({ line: 150, hotel: 150 });
    const linksBefore = await db.any(`SELECT id, quantity FROM tbl_arc_callof_po WHERE po_id=$1 ORDER BY id`, [poId]);

    await vendorRejects(poId, VENDOR, "Cannot supply");
    expect(await consumed()).toEqual({ line: 0, hotel: 0 });
    expect(await mrStatus(mrId)).toBe("approved");

    expect(await blockersFor(poId)).toEqual([]);
    await restore(poId, BUYER);

    expect(await consumed()).toEqual({ line: 150, hotel: 150 });
    expect(await mrStatus(mrId)).toBe("po_released");
    expect(await db.any(`SELECT id, quantity FROM tbl_arc_callof_po WHERE po_id=$1 ORDER BY id`, [poId]))
      .toEqual(linksBefore);
    const ev = await db.one(
      `SELECT actor_id, payload FROM tbl_arc_event_log
        WHERE arc_id=$1 AND event_type='call_off_rejection_reversed' AND (payload->>'po_id')::int = $2`,
      [arcId, poId]
    );
    expect(Number(ev.payload.mr_id)).toBe(Number(mrId));
    expect(ev.actor_id).toBe(BUYER);
  });

  it("call-off restore is blocked with CONTRACT_QUANTITY_EXCEEDED when the contract was drawn down since", async () => {
    const a = await releaseOne("drawn-a", 150, 71002);
    await vendorRejects(a.poId, VENDOR, "Cannot supply");
    await releaseOne("drawn-b", 900, 71003, { reset: false }); // another requisition took the room
    expect((await consumed()).line).toBe(900);

    expect(await blockersFor(a.poId)).toEqual([BLOCKERS.CONTRACT_QUANTITY_EXCEEDED]);
    await expect(restore(a.poId)).rejects.toMatchObject({ status: 409, code: BLOCKERS.CONTRACT_QUANTITY_EXCEEDED });
    expect((await consumed()).line).toBe(900);
    expect(await mrStatus(a.mrId)).toBe("approved");
  });

  it("blocked with REQUISITION_CHANGED when the MR was cancelled", async () => {
    const { mrId, poId } = await releaseOne("cancelled", 150, 71004);
    await vendorRejects(poId, VENDOR, "Cannot supply");
    await db.none(`UPDATE tbl_material_requisition SET status='cancelled' WHERE id=$1`, [mrId]);

    expect(await blockersFor(poId)).toEqual([BLOCKERS.REQUISITION_CHANGED]);
    await expect(restore(poId)).rejects.toMatchObject({ status: 409, code: BLOCKERS.REQUISITION_CHANGED });
    expect(await consumed()).toEqual({ line: 0, hotel: 0 });
    expect(await mrStatus(mrId)).toBe("cancelled");
  });

  it("blocked with CONTRACT_NOT_ACTIVE when the contract expired", async () => {
    const { poId } = await releaseOne("expired", 150, 71005);
    await vendorRejects(poId, VENDOR, "Cannot supply");

    // In its last days the contract is still live (the MR line picker agrees).
    await db.none(`UPDATE tbl_arc_contract SET status='expiring_soon' WHERE id=$1`, [contractId]);
    expect(await blockersFor(poId)).toEqual([]);

    await db.none(`UPDATE tbl_arc_contract SET status='expired' WHERE id=$1`, [contractId]);
    expect(await blockersFor(poId)).toEqual([BLOCKERS.CONTRACT_NOT_ACTIVE]);
    await expect(restore(poId)).rejects.toMatchObject({ status: 409, code: BLOCKERS.CONTRACT_NOT_ACTIVE });
    expect(await consumed()).toEqual({ line: 0, hotel: 0 });
  });
});

// ===========================================================================
//  Row lock on accept / reject
// ===========================================================================

describe("acceptPO / rejectPO row lock", () => {
  async function waitForLockWaiters(n, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { c } = await db.one(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if (c >= n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${n} sessions to queue on the PO row`);
  }

  // Resolves when the handler answered status 1; rejects with the HTTP status otherwise.
  async function act(handler, po_id, body = {}) {
    const m = mockExpress({ user: { id: ALPHA }, params: { po_id: String(po_id) }, body });
    await handler(m.req, m.res);
    if (m.calls.body?.status !== 1) {
      const err = new Error(m.calls.body?.message || "failed");
      err.status = m.calls.status;
      throw err;
    }
    return m.calls;
  }

  it("concurrent accept and reject cannot both succeed", async () => {
    const s = await awardedPo();

    // Hold the PO row so both requests are in flight before either can act —
    // the race is then deterministic rather than a matter of timing.
    let release;
    const held = new Promise((r) => { release = r; });
    let locked;
    const isLocked = new Promise((r) => { locked = r; });
    const holder = db.tx(async (t) => {
      await t.one(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [s.po_id]);
      locked();
      await held;
    });
    await isLocked;

    const accept = act(poController.acceptPO, s.po_id);
    const reject = act(poController.rejectPO, s.po_id, { reason: "Changed my mind" });
    await waitForLockWaiters(2);
    release();
    await holder;

    const results = await Promise.allSettled([accept, reject]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.status).toBe(409);

    // The PO and the award agree with whichever one won.
    const po = await readPo(s.po_id);
    const live = await liveFinalizations(s.rfq_id);
    if (results[0].status === "fulfilled") {
      expect(po.status).toBe("approved");
      expect(live).toHaveLength(1);
    } else {
      expect(po.status).toBe("rejected_by_vendor");
      expect(live).toHaveLength(0);
    }
  });
});
