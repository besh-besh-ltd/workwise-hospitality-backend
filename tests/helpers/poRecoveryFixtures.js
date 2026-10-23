// Shared fixtures for the REQ-0032 PO rejection-recovery suites (core, vendor
// undo, buyer send-back). Not a test file: jest only matches *.test.js.
//
// Usage, at the top of a suite and BEFORE any dynamic import of the app:
//
//   await installPostCommitTracking();
//   const poController = await import("../../app/controllers/po/purchaseOrderController.js");
//   const fx = recoveryFixtures();          // builders + cleanup for this suite
//   afterEach(fx.cleanup);
//   afterAll(async () => { await drainPostCommitWork(); await closeDb(); });
//
// Every case starts from a REAL rejection through the production rejectPO
// handler (fx.rejectedPo / fx.vendorRejects).

import { expect, jest } from "@jest/globals";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { poFixtures, newPoFixtureTracker, cleanupPoFixtures } from "./poFixtures.js";

const ALPHA = IDS.users.vendor_alpha;
const BUYER = IDS.users.a1_proc_buyer;

// ---- Post-commit work ------------------------------------------------------
//
// acceptPO / rejectPO (and the recovery notifier) answer first and notify
// afterwards without awaiting, and those in turn fire dispatchNotification
// without awaiting. Left alone, that work races a suite's cleanup and outlives
// closeDb() (pg-promise's end() shuts every pool in the process, the app's
// included). The real functions still run; they are only wrapped so the suite
// can wait for them, and so it can see which senders fired.
const pending = new Set();
const calls = [];
const track = (name, fn) => (...args) => {
  calls.push({ name, args });
  const p = Promise.resolve().then(() => fn(...args));
  pending.add(p);
  p.then(() => pending.delete(p), () => pending.delete(p));
  return p;
};

export async function drainPostCommitWork() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Tracked sender calls so far, optionally only one sender name. */
export const trackedCalls = (name) => calls.filter((c) => !name || c.name === name);
export const resetTrackedCalls = () => { calls.length = 0; };

/**
 * Wrap notificationService.dispatch and the PO email senders. Call once, before
 * the app modules are imported: notificationService is mocked BEFORE the real
 * purchaseOrderEmails is loaded, so that module binds to the tracked dispatch,
 * and both are mocked before any controller is loaded.
 */
export async function installPostCommitTracking() {
  const actualNotifications = await import("../../app/services/notificationService.js");
  jest.unstable_mockModule("../../app/services/notificationService.js", () => ({
    ...actualNotifications,
    dispatch: track("dispatch", actualNotifications.dispatch),
  }));
  const actualPoEmails = await import("../../app/controllers/po/purchaseOrderEmails.js");
  jest.unstable_mockModule("../../app/controllers/po/purchaseOrderEmails.js", () => ({
    ...actualPoEmails,
    sendPONotificationToVendor: track("sendPONotificationToVendor", actualPoEmails.sendPONotificationToVendor),
    sendPOAcceptedNotificationToTeam: track("sendPOAcceptedNotificationToTeam", actualPoEmails.sendPOAcceptedNotificationToTeam),
    sendVendorRejectionNotification: track("sendVendorRejectionNotification", actualPoEmails.sendVendorRejectionNotification),
  }));
}

// Notifications are keyed by entity in additional_data; delete only this suite's.
export async function deleteNotificationsFor({ poIds = [], mrIds = [] }) {
  if (!poIds.length && !mrIds.length) return;
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE (additional_data->>'po_id') = ANY($1::text[])
         OR (additional_data->>'mr_id') = ANY($2::text[])`,
    [poIds.map(String), mrIds.map(String)]
  );
}

export function mockExpress(opts = {}) {
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

/** Builders and cleanup bound to one suite's own tracker. */
export function recoveryFixtures() {
  const inserted = newPoFixtureTracker();
  const { makeRfqWithProductAndVendor, makeFinalization, makePo, attachProductToPo } = poFixtures(inserted);

  /** Delete everything this suite created. Order matters. Use as afterEach. */
  async function cleanup() {
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
  }

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
  const poController = await import("../../app/controllers/po/purchaseOrderController.js");
  const m = mockExpress({ user: { id: vendorId }, params: { po_id: String(po_id) }, body: { reason } });
  await poController.rejectPO(m.req, m.res);
  expect(m.calls.body).toMatchObject({ status: 1 });
}

async function rejectedPo(opts = {}) {
  const s = await awardedPo(opts);
  await vendorRejects(s.po_id, opts.vendorId ?? ALPHA);
  return s;
}

  return {
    inserted, cleanup,
    makeRfqWithProductAndVendor, makeFinalization, makePo, attachProductToPo,
    addProduct, addQuote, insertNq, awardedPo, vendorRejects, rejectedPo,
  };
}
