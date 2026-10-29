// Merging drafts keeps a source draft's send-back history and re-award trace.
// ----------------------------------------------------------------------------
// A draft can carry tbl_po_send_backs rows: a held PO goes back to draft when
// it is edited and its original initiator can no longer restart the approval.
// Those rows (and the files under them) are the PO's record, and their FK has
// no ON DELETE, so merging such a draft away used to fail on the delete. The
// source's replaces_po_id (the rejected PO it re-awards) was dropped too.
//
// Built through the real flows: the award, Initiate, the rejection, the
// re-award, the hold, the edit that returns the held PO to draft, and the
// merge, all over HTTP.
//
// Who is who (poSendBackWorld): APPROVER_B (a1_proc_finance) raises the
// re-award, so it creates PO1 and is the one person who may edit it; it can
// read POs but not initiate them. INITIATOR presses Initiate and is made
// inactive for the edit, so nobody restarts PO1's approval.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makeSendBackWorld, S, sendBackRows } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");

const world = makeSendBackWorld(db);
// A merged-away source PO no longer exists, so the world's cleanup (which finds
// approval instances through the RFQ's POs) cannot reach its instances.
const mergedAway = [];

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoRejectedNotifications();
  await drainPoSendBackNotifications();
  for (const { sourceId, keepId } of mergedAway.splice(0)) {
    await db.none(`UPDATE tbl_approval_instances SET entity_id = $2 WHERE entity_type = 'PO' AND entity_id = $1`, [sourceId, keepId]);
    await db.none(`DELETE FROM tbl_notifications WHERE (additional_data->>'po_id')::int = $1`, [sourceId]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = $1`, [sourceId]);
  }
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

const poRow = (id) =>
  db.one(`SELECT status::text AS status, replaces_po_id, finalized_vendor_id FROM tbl_rfq_purchase_order WHERE id = $1`, [id]);

describe("POST /po/merge-drafts with a source draft that has send-back history", () => {
  it("merges with 200; the history and the re-award trace move to the kept PO", async () => {
    const staged = await world.stageRfq({ products: 3, vendors: [S.VENDOR_A, S.VENDOR_B] });
    const [p1, p2] = staged.products; // p3 stays unawarded, so nothing auto-initiates

    // PO0: P1 to vendor A, rejected by its approver for re-award.
    const po0 = (await world.award(staged, p1, [S.VENDOR_A])).pos[0].id;
    await world.initiate(po0);
    expect((await world.rejectOnPoPage(po0, { remarks: "freight too high", reason_category: "RENEGOTIATE" })).status).toBe(200);

    // PO1: P1 re-awarded to vendor B. It traces PO0. Initiated.
    const po1 = (await world.award(staged, p1, [S.VENDOR_B], { raisedBy: S.APPROVER_B })).pos[0].id;
    expect(await poRow(po1)).toMatchObject({ status: "draft", replaces_po_id: po0 });
    const po1Instance = await world.initiate(po1);

    // PO2: P2 to vendor B, while PO1 is with its approver: a second draft.
    const po2 = (await world.award(staged, p2, [S.VENDOR_B])).pos[0].id;
    expect(po2).not.toBe(po1);
    expect(await poRow(po2)).toMatchObject({ status: "draft", replaces_po_id: null });

    // PO1 is held, then edited while its initiator is inactive: the approval
    // and the hold close, and PO1 is a draft again, carrying the hold's row.
    const held = await world.sendBack(S.PO_APPROVER, po1, {
      target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "Which floor is this for?",
    });
    expect(held.status).toBe(201);
    const sendBackId = held.body.data.send_back.id;
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [S.INITIATOR]);
    try {
      const edit = await (await world.client(S.APPROVER_B)).put(`/api/v1/po/${po1}`)
        .send({ changes: [{ path: "terms_and_conditions", newValue: "Net 45" }] });
      expect(edit.status).toBe(200);
    } finally {
      await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [S.INITIATOR]);
    }
    expect(await poRow(po1)).toMatchObject({ status: "draft", replaces_po_id: po0 });
    expect((await world.instanceState(po1Instance)).status).toBe("CANCELLED");
    expect((await sendBackRows(db, po1)).map((r) => [r.id, r.status, r.resolution]))
      .toEqual([[sendBackId, "SUPERSEDED", "PO_AMENDED_RESTARTED"]]);

    // Merge PO1 into PO2.
    mergedAway.push({ sourceId: po1, keepId: po2 });
    const merged = await (await world.client(S.INITIATOR)).post("/api/v1/po/merge-drafts")
      .send({ keep_po_id: po2, po_ids: [po1, po2] });
    expect(merged.status).toBe(200);
    expect(merged.body.data).toMatchObject({ keep_po_id: po2, merged_po_ids: [po1] });
    expect(await db.oneOrNone(`SELECT 1 FROM tbl_rfq_purchase_order WHERE id = $1`, [po1])).toBeNull();

    // The kept PO's thread has the hold.
    const thread = await world.thread(S.INITIATOR, po2);
    expect(thread.status).toBe(200);
    expect(thread.body.data.map((s) => [s.id, s.route, s.status, s.resolution, s.comment]))
      .toEqual([[sendBackId, "INFO_REQUEST", "SUPERSEDED", "PO_AMENDED_RESTARTED", "Which floor is this for?"]]);

    // The kept PO now traces the rejected PO0, with the approver's reason.
    expect((await poRow(po2)).replaces_po_id).toBe(po0);
    const detail = await (await world.client(S.INITIATOR)).get(`/api/v1/po/detail/${po2}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.replaces).toEqual(expect.objectContaining({
      po_id: po0, reason_category: "RENEGOTIATE", comment: "freight too high",
    }));
  });
});
