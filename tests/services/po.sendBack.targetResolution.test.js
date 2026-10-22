// Who an approver can ask, and who can see or touch a hold (client ticket T3).
// ----------------------------------------------------------------------------
// The person asked is always resolved on the server from the RFQ and the PO,
// never taken from the request:
//
//   RFQ_CREATOR          tbl_rfq.created_by
//   PO_INITIATOR         the PO's creator (tbl_rfq_purchase_order.initiated_by)
//   COMMERCIAL_EVALUATOR whoever raised the latest approved award approval
//   TECHNICAL_EVALUATOR  whoever raised the latest approved technical approval
//
// Someone inactive, someone who cannot see the PO, and the caller themselves
// are listed but not offered. Another tenant gets 404 everywhere, a vendor 403,
// and a vendor never sees a hold in anything they can read.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { makeSendBackWorld, S, PNG, keysOf, sendBackRows } = await import("../helpers/poSendBackWorld.js");
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

const ROLES = ["RFQ_CREATOR", "PO_INITIATOR", "COMMERCIAL_EVALUATOR", "TECHNICAL_EVALUATOR"];
const ask = (who, poId, target_role, extra = {}) =>
  world.sendBack(who, poId, { target_role, reason_category: "INFO_MISSING", comment: "Please explain", ...extra });

async function targetsOf(who, poId) {
  const res = await world.targets(who, poId);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  const rows = res.body.data.targets;
  expect(rows.map((r) => r.target_role)).toEqual(ROLES);
  for (const r of rows) {
    expect(keysOf(r)).toEqual(r.available ? ["available", "target_role", "user"] : ["available", "target_role", "unavailable_reason", "user"]);
    if (r.user) expect(keysOf(r.user)).toEqual(["id", "name"]);
    if (!r.available) expect(r.unavailable_reason).toEqual(expect.any(String));
  }
  return Object.fromEntries(rows.map((r) => [r.target_role, r]));
}

async function withInactive(userId, fn) {
  const { status } = await db.one(`SELECT status FROM tbl_users WHERE id = $1`, [userId]);
  await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [userId]);
  try {
    return await fn();
  } finally {
    await db.none(`UPDATE tbl_users SET status = $2 WHERE id = $1`, [userId, status]);
  }
}

/** A TECHNICAL approval for the RFQ, `daysAgo` old. */
async function techApproval(rfqId, { status, initiatedBy, daysAgo, productId = null }) {
  const row = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id,
        initiated_by, metadata, created_at, completed_at, process_id)
     VALUES ('TECHNICAL', $1, $2, $3, 1, $4, $5, $6, $7::jsonb,
             NOW() - make_interval(days => $8), CASE WHEN $3 = 'PENDING' THEN NULL ELSE NOW() - make_interval(days => $8) END, $9)
     RETURNING id`,
    [rfqId, IDS.policies.A1_P1_TECHNICAL, status, IDS.hospitality.A, IDS.hotels.A1, initiatedBy,
      JSON.stringify({ rfq_id: rfqId, rfq_product_id: productId }), daysAgo, IDS.processes.A_P1]
  );
  world.trackInstance(row.id);
  return row.id;
}

describe("who can be asked", () => {
  it("ignores a forged target_user_id in the body", async () => {
    const a = await world.poAtStep2();
    const res = await ask(S.APPROVER_A, a.poId, "RFQ_CREATOR", {
      fields: { target_user_id: S.OUTSIDER, requested_by: S.OUTSIDER, rfq_id: 1, approval_instance_id: 1, status: "ANSWERED" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.send_back.target).toEqual({ id: S.CREATOR, name: await world.nameOf(S.CREATOR) });

    const [row] = await sendBackRows(db, a.poId);
    expect(row).toMatchObject({ target_user_id: S.CREATOR, requested_by: S.APPROVER_A, status: "OPEN" });
    const stored = await db.one(`SELECT rfq_id, approval_instance_id FROM tbl_po_send_backs WHERE id = $1`, [row.id]);
    expect(stored).toEqual({ rfq_id: a.rfq.id, approval_instance_id: a.instanceId });
  });

  it("does not offer a deactivated target", async () => {
    // APPROVER_A raised the award, so they are both the PO's creator and its
    // commercial evaluator.
    const a = await world.poAtStep2({ raisedBy: S.APPROVER_A });
    const nameA = await world.nameOf(S.APPROVER_A);

    const forB = await targetsOf(S.APPROVER_B, a.poId);
    expect(forB.RFQ_CREATOR).toEqual({ target_role: "RFQ_CREATOR", user: { id: S.CREATOR, name: await world.nameOf(S.CREATOR) }, available: true });
    expect(forB.PO_INITIATOR).toEqual({ target_role: "PO_INITIATOR", user: { id: S.APPROVER_A, name: nameA }, available: true });
    expect(forB.COMMERCIAL_EVALUATOR).toEqual({ target_role: "COMMERCIAL_EVALUATOR", user: { id: S.APPROVER_A, name: nameA }, available: true });
    expect(forB.TECHNICAL_EVALUATOR).toMatchObject({ user: null, available: false });

    // Never yourself.
    const forA = await targetsOf(S.APPROVER_A, a.poId);
    expect(forA.PO_INITIATOR).toMatchObject({ user: { id: S.APPROVER_A, name: nameA }, available: false });
    expect(forA.COMMERCIAL_EVALUATOR).toMatchObject({ available: false });
    expect(forA.RFQ_CREATOR.available).toBe(true);

    // Inactive: listed by name, not offered, and refused if asked anyway.
    await withInactive(S.CREATOR, async () => {
      const t = await targetsOf(S.APPROVER_B, a.poId);
      expect(t.RFQ_CREATOR).toMatchObject({ user: { id: S.CREATOR }, available: false });
      const res = await ask(S.APPROVER_B, a.poId, "RFQ_CREATOR");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_TARGET");
    });

    // Someone who cannot read purchase orders cannot answer about one.
    await db.none(`UPDATE tbl_rfq_purchase_order SET initiated_by = $2 WHERE id = $1`, [a.poId, S.COMM_EVAL]);
    const t = await targetsOf(S.APPROVER_B, a.poId);
    expect(t.PO_INITIATOR).toMatchObject({ user: { id: S.COMM_EVAL }, available: false });
    const res = await ask(S.APPROVER_B, a.poId, "PO_INITIATOR");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_TARGET");
    expect(await sendBackRows(db, a.poId)).toEqual([]);

    // The ones on offer can be asked.
    const ok = await ask(S.APPROVER_B, a.poId, "COMMERCIAL_EVALUATOR");
    expect(ok.status).toBe(201);
    expect(ok.body.data.send_back.target).toEqual({ id: S.APPROVER_A, name: nameA });
  });

  it("TECHNICAL_EVALUATOR target resolves from the approved technical instance", async () => {
    const a = await world.poAtStep2();
    const other = await world.stageRfq({ products: 1, vendors: [S.VENDOR_A] });

    await techApproval(a.rfq.id, { status: "APPROVED", initiatedBy: S.TECH_EVAL, daysAgo: 3 });
    await techApproval(a.rfq.id, { status: "REJECTED", initiatedBy: S.CREATOR, daysAgo: 1 });
    await techApproval(a.rfq.id, { status: "PENDING", initiatedBy: S.CREATOR, daysAgo: 0 });
    await techApproval(other.rfq.id, { status: "APPROVED", initiatedBy: S.CREATOR, daysAgo: 0 });

    // The latest APPROVED one for this RFQ: the technical evaluator, who
    // cannot read purchase orders, so is named but not offered.
    let t = await targetsOf(S.APPROVER_A, a.poId);
    expect(t.TECHNICAL_EVALUATOR).toMatchObject({
      user: { id: S.TECH_EVAL, name: await world.nameOf(S.TECH_EVAL) }, available: false,
    });

    // A later approval by someone who can read it takes over.
    await techApproval(a.rfq.id, { status: "APPROVED", initiatedBy: S.LAST_APPROVER, daysAgo: 2 });
    t = await targetsOf(S.APPROVER_A, a.poId);
    expect(t.TECHNICAL_EVALUATOR).toEqual({
      target_role: "TECHNICAL_EVALUATOR", user: { id: S.LAST_APPROVER, name: await world.nameOf(S.LAST_APPROVER) }, available: true,
    });

    const res = await ask(S.APPROVER_A, a.poId, "TECHNICAL_EVALUATOR", { reason_category: "TECH_QUERY" });
    expect(res.status).toBe(201);
    const [row] = await sendBackRows(db, a.poId);
    expect(row).toMatchObject({ target_role: "TECHNICAL_EVALUATOR", target_user_id: S.LAST_APPROVER, route: "INFO_REQUEST" });
  });
});

describe("who can see and touch a hold", () => {
  it("a non-target answering gets 404", async () => {
    const a = await world.poAtStep2();
    const held = await ask(S.APPROVER_A, a.poId, "RFQ_CREATOR");
    expect(held.status).toBe(201);
    const id = held.body.data.send_back.id;

    // In scope or not, on the step or not: only the person asked may answer.
    for (const who of [S.APPROVER_A, S.APPROVER_B, S.LAST_APPROVER, S.OUTSIDER]) {
      const res = await world.respond(who, id, { response_text: "I know", files: [PNG] });
      expect({ who, status: res.status }).toEqual({ who, status: 404 });
    }
    expect((await sendBackRows(db, a.poId)).map((r) => r.status)).toEqual(["OPEN"]);
    expect((await world.actions(a.instanceId)).filter((x) => x.action === "SEND_BACK_ANSWERED")).toEqual([]);
  });

  it("an out-of-scope buyer gets 404 on every endpoint", async () => {
    const a = await world.poAtStep2();
    const held = await ask(S.APPROVER_A, a.poId, "RFQ_CREATOR");
    const id = held.body.data.send_back.id;

    const calls = {
      targets: await world.targets(S.OUTSIDER, a.poId),
      create: await ask(S.OUTSIDER, a.poId, "RFQ_CREATOR"),
      list: await world.thread(S.OUTSIDER, a.poId),
      respond: await world.respond(S.OUTSIDER, id, { response_text: "x" }),
      withdraw: await world.withdraw(S.OUTSIDER, id, "x"),
    };
    for (const [name, res] of Object.entries(calls)) {
      expect({ name, status: res.status }).toEqual({ name, status: 404 });
      expect(JSON.stringify(res.body)).not.toMatch(/Please explain|INFO_REQUEST|RFQ_CREATOR/);
    }

    // Ids that do not exist look the same to an in-scope user.
    expect((await world.targets(S.APPROVER_A, 2147483000)).status).toBe(404);
    expect((await world.thread(S.APPROVER_A, 2147483000)).status).toBe(404);
    expect((await world.respond(S.CREATOR, 2147483000, { response_text: "x" })).status).toBe(404);
    expect((await world.withdraw(S.APPROVER_A, 2147483000)).status).toBe(404);

    expect((await sendBackRows(db, a.poId)).map((r) => r.status)).toEqual(["OPEN"]);
  });

  it("a vendor gets 403 on every endpoint and never sees the hold in their PO list", async () => {
    const a = await world.poAtStep2();
    const held = await ask(S.APPROVER_A, a.poId, "RFQ_CREATOR", { comment: "Internal: vendor looks pricey" });
    const id = held.body.data.send_back.id;

    const calls = {
      targets: await world.targets(S.VENDOR_A, a.poId),
      create: await ask(S.VENDOR_A, a.poId, "RFQ_CREATOR"),
      list: await world.thread(S.VENDOR_A, a.poId),
      respond: await world.respond(S.VENDOR_A, id, { response_text: "x" }),
      withdraw: await world.withdraw(S.VENDOR_A, id, "x"),
    };
    for (const [name, res] of Object.entries(calls)) {
      expect({ name, status: res.status }).toEqual({ name, status: 403 });
    }

    // Answer it and finish the approval, so the PO reaches the vendor.
    expect((await world.respond(S.CREATOR, id, { response_text: "Internal: fine" })).status).toBe(200);
    expect((await world.approve(S.APPROVER_A, a.poId)).status).toBe(200);
    expect((await world.approve(S.LAST_APPROVER, a.poId)).status).toBe(200);
    expect((await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).s)
      .toBe("acceptance_pending");

    const vendor = await world.client(S.VENDOR_A);
    const list = await vendor.post("/api/v1/po/vendor/list-view").send({ tab: "all", page: 1, limit: 50 });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(String(a.poId));
    const detail = await vendor.get(`/api/v1/po/vendor/detail/${a.poId}`);
    expect(detail.status).toBe(200);
    const legacy = await vendor.get(`/api/v1/po/${a.poId}`);
    expect(legacy.status).toBe(200);
    for (const res of [list, detail, legacy]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/send_back|"hold"|INFO_REQUEST|Internal: vendor looks pricey|Internal: fine|Waiting on/);
    }

    // And no vendor was ever told about it.
    const vendorNotes = await db.any(
      `SELECT type FROM tbl_notifications
        WHERE recipient_user_id = ANY($1::int[]) AND type LIKE 'po_send_back%'`,
      [[S.VENDOR_A, S.VENDOR_B]]
    );
    expect(vendorNotes).toEqual([]);
  });
});
