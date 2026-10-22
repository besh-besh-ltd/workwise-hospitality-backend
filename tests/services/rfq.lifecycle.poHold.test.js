// A PO on hold, as the RFQ and the PO dashboards show it (client ticket T3).
// ----------------------------------------------------------------------------
// A hold is not a stage. The RFQ stays at PO_APPROVAL while any of its POs is
// with an approver, held or not; each PO on the lifecycle says whether it is
// held, by whom and for what (`hold`), and is null when it is not.
//
// A held PO waits on the person asked, not on its approvers: it leaves their
// "pending for me" everywhere (PO dashboard, awaiting list, action-required
// filter, approval inbox and badge, the RFQ's action holders) and shows up for
// the person asked under /po/awaiting `information_requests` and in their
// action-required filter.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makeSendBackWorld, S, keysOf } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");

const world = makeSendBackWorld(db);

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoSendBackNotifications();
  await drainPoRejectedNotifications();
  await world.cleanup();
});
afterAll(async () => {
  await world.teardown();
  await closeDb();
});

/** The PO stage of the RFQ workspace, read by the CEO-level initiator. */
async function poStage(rfqId, who = S.INITIATOR) {
  const res = await (await world.client(who)).get(`/api/v1/rfq/${rfqId}/lifecycle`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  const stage = res.body.data.stages.find((s) => s.key === "purchase-order");
  const pos = stage.phase.purchase_orders || [];
  return { current: res.body.data.current_status, phase: stage.phase, byId: (id) => pos.find((p) => Number(p.id) === Number(id)) };
}

const ask = (who, poId, reason_category = "INFO_MISSING") =>
  world.sendBack(who, poId, { target_role: "RFQ_CREATOR", reason_category, comment: "Which floor is this for?" });

/** `n` products, product i to vendors[i], each PO initiated and with PO_APPROVER. */
async function pendingPos(vendors) {
  const staged = await world.stageRfq({ products: vendors.length, vendors: [S.VENDOR_A, S.VENDOR_B] });
  const poIds = [];
  for (let i = 0; i < vendors.length; i++) {
    const { pos } = await world.award(staged, staged.products[i], [vendors[i]]);
    expect(pos).toHaveLength(1);
    await world.initiate(pos[0].id);
    poIds.push(pos[0].id);
  }
  return { ...staged, poIds };
}

describe("RFQ lifecycle — a PO on hold", () => {
  it("exposes the hold descriptor and keeps the RFQ at PO_APPROVAL with one PO held, a sibling approved and a third rejected", async () => {
    const r = await pendingPos([S.VENDOR_A, S.VENDOR_B, S.VENDOR_A]);
    const [held, approved, rejected] = r.poIds;

    const sent = await ask(S.PO_APPROVER, held);
    expect(sent.status).toBe(201);
    expect((await world.approve(S.PO_APPROVER, approved)).status).toBe(200);
    expect((await world.reject(S.PO_APPROVER, rejected, { reason_category: "PRICE_TAX_QUERY" })).status).toBe(200);

    const view = await poStage(r.rfq.id);
    expect(view.current).toBe("PO_APPROVAL");
    expect(view.phase.sub_status).toBe("approving");

    const hold = view.byId(held).hold;
    expect(keysOf(hold)).toEqual(["reason_category", "requested_by", "send_back_id", "since", "target", "target_role"]);
    expect(hold).toEqual({
      send_back_id: sent.body.data.send_back.id,
      target_role: "RFQ_CREATOR",
      target: { id: S.CREATOR, name: await world.nameOf(S.CREATOR) },
      reason_category: "INFO_MISSING",
      since: expect.any(String),
      requested_by: { id: S.PO_APPROVER, name: await world.nameOf(S.PO_APPROVER) },
    });
    expect(Number.isNaN(Date.parse(hold.since))).toBe(false);
    expect(view.byId(approved).hold).toBeNull();
    expect(view.byId(rejected).hold).toBeNull();

    // The only PO with an approver is held, so no approver is holding the RFQ up.
    expect((view.phase.action_holders?.users || []).map((u) => u.id)).not.toContain(S.PO_APPROVER);

    // Answered: no longer held, and its approver is the one to act again.
    expect((await world.respond(S.CREATOR, hold.send_back_id, { response_text: "Third floor" })).status).toBe(200);
    const after = await poStage(r.rfq.id);
    expect(after.current).toBe("PO_APPROVAL");
    expect(after.byId(held).hold).toBeNull();
    expect((after.phase.action_holders?.users || []).map((u) => u.id)).toContain(S.PO_APPROVER);

    // Held again and withdrawn: null again.
    const again = await ask(S.PO_APPROVER, held, "OTHER");
    expect(again.status).toBe(201);
    expect((await poStage(r.rfq.id)).byId(held).hold).toMatchObject({ send_back_id: again.body.data.send_back.id, reason_category: "OTHER" });
    expect((await world.withdraw(S.PO_APPROVER, again.body.data.send_back.id)).status).toBe(200);
    expect((await poStage(r.rfq.id)).byId(held).hold).toBeNull();

    // A vendor reaches neither lifecycle payload.
    const vendor = await world.client(S.VENDOR_A);
    const ask2 = await ask(S.PO_APPROVER, held);
    expect(ask2.status).toBe(201);
    for (const path of [`/api/v1/rfq/${r.rfq.id}/lifecycle`, `/api/v1/rfq/lifecycle-summary/${r.rfq.id}`]) {
      const res = await vendor.get(path);
      expect(JSON.stringify(res.body)).not.toMatch(/"hold"|send_back|Which floor/);
    }
  });

  it("approver pending count excludes the held PO; the target sees it under information_requests", async () => {
    const r = await pendingPos([S.VENDOR_A, S.VENDOR_B]);
    const [held, other] = r.poIds;
    const approver = await world.client(S.PO_APPROVER);
    const creator = await world.client(S.CREATOR);

    const snapshot = async () => {
      const awaiting = await approver.get("/api/v1/po/awaiting");
      const kpis = await approver.get("/api/v1/po/dashboard/kpis");
      const list = await approver.get("/api/v1/po/list?status=action-required&limit=100");
      const inbox = await approver.get("/api/v1/general/hospitality/approval/pending?entity_type=PO");
      const badge = await approver.get("/api/v1/general/hospitality/approval/pending/counts");
      for (const res of [awaiting, kpis, list, inbox, badge]) expect(res.status).toBe(200);
      return {
        awaiting: awaiting.body.data.map((p) => Number(p.id)),
        awaitingYou: kpis.body.awaitingYou,
        list: list.body.data.map((p) => Number(p.id)),
        actionRequired: list.body.status_counts.action_required,
        inbox: inbox.body.data.map((i) => Number(i.entity_id)),
        badge: Number(badge.body.data.find((c) => c.entity_type === "PO")?.count || 0),
      };
    };

    const before = await snapshot();
    for (const id of [held, other]) {
      expect(before.awaiting).toContain(id);
      expect(before.list).toContain(id);
      expect(before.inbox).toContain(id);
    }

    const sent = await ask(S.PO_APPROVER, held, "EVIDENCE_MISSING");
    expect(sent.status).toBe(201);

    const during = await snapshot();
    expect(during.awaiting).toContain(other);
    expect(during.awaiting).not.toContain(held);
    expect(during.list).toContain(other);
    expect(during.list).not.toContain(held);
    expect(during.inbox).toContain(other);
    expect(during.inbox).not.toContain(held);
    expect(during.awaitingYou).toBe(before.awaitingYou - 1);
    expect(during.actionRequired).toBe(before.actionRequired - 1);
    expect(during.badge).toBe(before.badge - 1);
    expect((await approver.get("/api/v1/po/awaiting")).body.information_requests).toEqual([]);

    // The person asked: it is theirs to act on now.
    const mine = await creator.get("/api/v1/po/awaiting");
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((p) => Number(p.id))).not.toContain(held);
    const reqs = mine.body.information_requests.filter((x) => x.po_id === held);
    expect(reqs).toHaveLength(1);
    expect(keysOf(reqs[0])).toEqual(["po_id", "po_number", "reason_category", "requested_by", "rfq_no", "send_back_id", "since"]);
    const po = await db.one(`SELECT po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [held]);
    expect(reqs[0]).toEqual({
      send_back_id: sent.body.data.send_back.id,
      po_id: held,
      po_number: po.po_number,
      rfq_no: r.rfq.rfq_no,
      reason_category: "EVIDENCE_MISSING",
      requested_by: await world.nameOf(S.PO_APPROVER),
      since: expect.any(String),
    });
    const creatorList = await creator.get("/api/v1/po/list?status=action-required&limit=100");
    expect(creatorList.status).toBe(200);
    expect(creatorList.body.data.map((p) => Number(p.id))).toContain(held);
    expect(creatorList.body.data.map((p) => Number(p.id))).not.toContain(other);

    // Answered: back with the approver, gone from the person asked.
    expect((await world.respond(S.CREATOR, sent.body.data.send_back.id, { response_text: "attached" })).status).toBe(200);
    const afterAnswer = await snapshot();
    expect(afterAnswer.awaiting).toEqual(expect.arrayContaining([held, other]));
    expect(afterAnswer.list).toEqual(expect.arrayContaining([held, other]));
    expect(afterAnswer.awaitingYou).toBe(before.awaitingYou);
    expect(afterAnswer.badge).toBe(before.badge);
    expect((await creator.get("/api/v1/po/awaiting")).body.information_requests.filter((x) => x.po_id === held)).toEqual([]);
    expect((await creator.get("/api/v1/po/list?status=action-required&limit=100")).body.data.map((p) => Number(p.id)))
      .not.toContain(held);
  });
});
