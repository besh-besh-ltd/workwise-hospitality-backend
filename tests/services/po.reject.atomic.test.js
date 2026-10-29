// One atomic PO rejection (client ticket T3).
// ----------------------------------------------------------------------------
// Rejecting a PO is one decision with five effects: the approval decision, the
// PO status, the vendor's de-finalization, a closed send-back row carrying the
// reason, and a lifecycle row. They commit together or not at all, and the two
// places an approver can reject from (the PO page and the generic approval
// card) must leave the database in the same state.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const sentMails = [];
const fakeTransport = {
  sendMail: (opts, cb) => { sentMails.push(opts); cb(null, { messageId: "<captured>" }); },
};
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, sendBacksFor, finalizationsFor, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const world = makePoRejectWorld(db);

beforeAll(() => world.setup());
afterEach(() => world.cleanup());
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

/** Everything a rejection touches, with ids normalised away. */
async function snapshot(staged, since) {
  const po = await db.one(
    `SELECT status::text AS status, approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1`, [staged.poId]);
  const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [po.approval_instance_id]);
  const steps = await db.any(
    `SELECT step_order, status FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order`,
    [po.approval_instance_id]);
  const actions = await db.any(
    `SELECT action, comment, approver_user_id FROM tbl_approval_actions WHERE approval_instance_id = $1 ORDER BY id`,
    [po.approval_instance_id]);
  const nq = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [staged.nqInstanceId]);
  const live = await finalizationsFor(db, staged.rfq.id, W.VENDOR_A);
  const history = await db.any(
    `SELECT vendor_id, created_by, changed_by FROM tbl_quote_finalization_history WHERE rfq_id = $1 ORDER BY id`,
    [staged.rfq.id]);
  const lifecycle = await db.any(
    `SELECT stage, action FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = $1 ORDER BY id`,
    [staged.poId]);
  await drainPoRejectedNotifications();
  // Every notice a rejection has ever produced (the current ones and the two
  // it replaced); the initiate notices land asynchronously and are not ours.
  const notes = await db.any(
    `SELECT type, recipient_user_id FROM tbl_notifications
      WHERE ((additional_data->>'po_id')::int = $1
             OR (additional_data->>'entity_type' = 'PO' AND (additional_data->>'entity_id')::int = $1))
        AND created_at >= $2
        AND type IN ('po_rejected', 'po_cancelled', 'po_sent_back', 'approval_rejected')
      ORDER BY type, recipient_user_id`,
    [staged.poId, since]);
  const sendBacks = (await sendBacksFor(db, staged.poId)).map(({ step_order, ...rest }) => rest);
  return {
    po: po.status, instance: inst.status, steps, actions, nq: nq.status,
    live: live.length, history, lifecycle, notes, sendBacks,
  };
}

describe("PO rejection is one atomic decision", () => {
  it("rolls back everything when de-finalization fails", async () => {
    const a = await world.pendingPo();
    const b = await world.pendingPo();
    // A test-only trigger refuses the archive insert for exactly these RFQs.
    await db.none(`
      CREATE OR REPLACE FUNCTION pg_temp_po_reject_refuse() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.rfq_id IN (${Number(a.rfq.id)}, ${Number(b.rfq.id)}) THEN
          RAISE EXCEPTION 'test: finalization history insert refused';
        END IF;
        RETURN NEW;
      END
      $fn$`);
    await db.none(`
      CREATE TRIGGER test_po_reject_refuse BEFORE INSERT ON tbl_quote_finalization_history
      FOR EACH ROW EXECUTE FUNCTION pg_temp_po_reject_refuse()`);
    try {
      const viaPage = await world.rejectOnPoPage(a.poId, { remarks: "wrong price", reason_category: "PRICE_TAX_QUERY" });
      const viaCard = await world.rejectOnApprovalCard(b.instanceId, { remarks: "wrong price", reason_category: "PRICE_TAX_QUERY" });

      for (const [res, staged] of [[viaPage, a], [viaCard, b]]) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        const po = await db.one(`SELECT status::text AS status FROM tbl_rfq_purchase_order WHERE id = $1`, [staged.poId]);
        expect(po.status).toBe("pending_approval");
        const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [staged.instanceId]);
        expect(inst.status).toBe("PENDING");
        const actions = await db.any(`SELECT 1 FROM tbl_approval_actions WHERE approval_instance_id = $1 AND action = 'REJECT'`, [staged.instanceId]);
        expect(actions).toHaveLength(0);
        expect(await finalizationsFor(db, staged.rfq.id, W.VENDOR_A)).toHaveLength(1);
        expect(await sendBacksFor(db, staged.poId)).toHaveLength(0);
      }
    } finally {
      await db.none(`DROP TRIGGER IF EXISTS test_po_reject_refuse ON tbl_quote_finalization_history`);
      await db.none(`DROP FUNCTION IF EXISTS pg_temp_po_reject_refuse()`);
    }
  });

  it("both reject surfaces end in the identical state", async () => {
    const a = await world.pendingPo();
    const b = await world.pendingPo();
    const since = new Date();

    const viaPage = await world.rejectOnPoPage(a.poId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(viaPage.status).toBe(200);
    expect(viaPage.body.status).toBe(1);
    const viaCard = await world.rejectOnApprovalCard(b.instanceId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(viaCard.status).toBe(200);
    expect(viaCard.body.status).toBe(1);

    const left = await snapshot(a, since);
    const right = await snapshot(b, since);
    expect(right).toEqual(left);

    // And that state is the full rejection, not merely the same partial one.
    expect(left.po).toBe("rejected");
    expect(left.instance).toBe("REJECTED");
    expect(left.nq).toBe("CANCELLED");
    expect(left.live).toBe(0);
    expect(left.history).toEqual([{ vendor_id: W.VENDOR_A, created_by: W.COMM_APP, changed_by: W.PO_APPROVER }]);
    expect(left.sendBacks).toEqual([{
      route: "COMMERCIAL", reason_category: "PRICE_TAX_QUERY", comment: "GST is wrong",
      requested_by: W.PO_APPROVER, status: "CLOSED", resolution: "REJECTED",
      target_role: null, target_user_id: null, closed: true,
    }]);
    // ONE lifecycle row per rejection (ruling R21): the engine's REJECT row.
    // Route, reason and comment live on the send-back above; a second row
    // would be counted twice by the activity backfill.
    expect(left.lifecycle.filter((r) => r.action === "REJECT" || /REJECT|CANCEL/.test(r.stage))).toEqual([
      { stage: "REJECTED", action: "REJECT" },
    ]);
  });

  it("an old client without reason_category is stored as OTHER/COMMERCIAL", async () => {
    const a = await world.pendingPo();
    // Exactly what the pre-release frontend bundle sends.
    const res = await world.rejectOnPoPage(a.poId, { remarks: "old bundle" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const po = await db.one(`SELECT status::text AS status FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId]);
    expect(po.status).toBe("rejected");
    expect(await sendBacksFor(db, a.poId)).toEqual([expect.objectContaining({
      route: "COMMERCIAL", reason_category: "OTHER", comment: "old bundle",
      status: "CLOSED", resolution: "REJECTED", requested_by: W.PO_APPROVER,
    })]);
  });

  it("refuses the TECHNICAL route with ROUTE_NOT_AVAILABLE", async () => {
    const a = await world.pendingPo();
    const viaPage = await world.rejectOnPoPage(a.poId, {
      remarks: "re-check the tech eval", reason_category: "TECH_QUERY", route: "TECHNICAL",
    });
    expect(viaPage.status).toBe(400);
    expect(viaPage.body.code).toBe("ROUTE_NOT_AVAILABLE");

    const viaCard = await world.rejectOnApprovalCard(a.instanceId, {
      remarks: "re-check the tech eval", reason_category: "TECH_QUERY", route: "TECHNICAL",
    });
    expect(viaCard.status).toBe(400);
    expect(viaCard.body.code).toBe("ROUTE_NOT_AVAILABLE");

    // Nothing happened.
    const po = await db.one(`SELECT status::text AS status FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId]);
    expect(po.status).toBe("pending_approval");
    const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [a.instanceId]);
    expect(inst.status).toBe("PENDING");
    expect(await finalizationsFor(db, a.rfq.id, W.VENDOR_A)).toHaveLength(1);
  });

  it("refuses an unknown reason, and a cancel with a reason that is not about need, with INVALID_REASON", async () => {
    const a = await world.pendingPo();
    const unknown = await world.rejectOnPoPage(a.poId, { remarks: "x", reason_category: "TOO_EXPENSIVE" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("INVALID_REASON");

    const cancelForPrice = await world.rejectOnPoPage(a.poId, { remarks: "x", reason_category: "PRICE_TAX_QUERY", route: "CANCEL" });
    expect(cancelForPrice.status).toBe(400);
    expect(cancelForPrice.body.code).toBe("INVALID_REASON");

    const inst = await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [a.instanceId]);
    expect(inst.status).toBe("PENDING");
  });
});
