// An approver puts a PO on hold by asking a named person for information
// (client ticket T3, request-info hold).
// ----------------------------------------------------------------------------
// The hold is an OPEN row in tbl_po_send_backs and nothing else: the approval
// instance stays PENDING at the same step and no step or approver status
// changes. While it is open nobody on that step can approve or reject, on
// either surface. The named person answers (text, files or both), or any
// pending approver on the step withdraws it, and the same step carries on:
// earlier steps are never asked again.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport; S3 is the
// suite-wide stub from tests/setup/jestEnv.js, wrapped here to record calls.

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
const { makeSendBackWorld, S, PNG, PDF, TXT, keysOf, sendBackRows } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");
const { default: s3Client } = await import("../../app/config/s3config.js");

// Record every S3 call. The function underneath is jestEnv's stub, so nothing
// leaves the machine; the assertion below fails if that ever stops being true.
const s3Calls = [];
const stubbedSend = s3Client.send;
s3Client.send = function recordS3(cmd, ...rest) {
  s3Calls.push({ op: cmd?.constructor?.name, key: cmd?.input?.Key });
  return stubbedSend.call(this, cmd, ...rest);
};

const world = makeSendBackWorld(db);

beforeAll(() => world.setup());
afterEach(async () => {
  await drainPoSendBackNotifications();
  await drainPoRejectedNotifications();
  sentMails.length = 0;
  s3Calls.length = 0;
  await world.cleanup();
});
afterAll(async () => {
  s3Client.send = stubbedSend;
  await world.teardown();
  await closeDb();
});

const SEND_BACK_KEYS = [
  "closed_at", "comment", "created_at", "files", "id", "reason_category", "requested_by", "resolution",
  "responded_at", "responded_by", "response_text", "route", "status", "target", "target_role",
].sort();

const notificationsFor = (poId, type) =>
  db.any(
    `SELECT recipient_user_id, title, message, action_url FROM tbl_notifications
      WHERE (additional_data->>'po_id')::int = $1 AND type = $2 ORDER BY recipient_user_id`,
    [poId, type]
  );
const mailTo = async (userId) => (await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [userId])).email;
const docRows = (poId) =>
  db.one(`SELECT COUNT(*)::int AS n FROM tbl_purchase_order_document WHERE purchase_order_id = $1`, [poId]);
const decisionActions = async (instanceId) =>
  (await world.actions(instanceId)).filter((a) => a.action === "APPROVE" || a.action === "REJECT");

/**
 * A call-off PO in hotel A1 / procurement / process P1: an ARC, its contract
 * with vendor A, a requisition, and the PO released against them. The fields
 * the call-off check needs, nothing more.
 */
async function callOffPo() {
  const { IDS } = await import("../fixtures/ids.js");
  const { TEST_CATEGORIES } = await import("../fixtures/vendors.js");
  const stamp = Date.now();
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'send-back call-off', $2, $3, $4, $5, $6, 'contract_active',
             NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $7)
     RETURNING id`,
    [`ARC-SB-${stamp}`, TEST_CATEGORIES.beverages, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1, S.CREATOR]
  );
  const contract = await db.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`, [arc.id, S.VENDOR_A]);
  const mr = await db.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
     VALUES ($1, 'send-back call-off', $2, $3, $4, 'normal', $5, 'approved', NOW()) RETURNING id`,
    [`MR-SB-${stamp}`, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, S.CREATOR]
  );
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id, total_value,
        is_call_off, arc_contract_id, source_mr_id)
     VALUES ($1, $2, 'pending_approval', '{}', 1, 1, $3, 1, TRUE, $4, $5) RETURNING id`,
    [IDS.companies.A, `CO-SB-${stamp}`, S.VENDOR_A, contract.id, mr.id]
  );
  return {
    poId: po.id,
    async cleanup() {
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = $1`, [po.id]);
      await db.none(`DELETE FROM tbl_material_requisition WHERE id = $1`, [mr.id]);
      await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contract.id]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arc.id]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arc.id]);
    },
  };
}

/** APPROVER_A asks the RFQ creator for evidence on a PO waiting at L2. */
async function heldAtStep2(opts) {
  const a = await world.poAtStep2(opts);
  const res = await world.sendBack(S.APPROVER_A, a.poId, {
    target_role: "RFQ_CREATOR",
    reason_category: "EVIDENCE_MISSING",
    comment: "Please attach the site photos",
    files: [PDF],
  });
  expect(res.status).toBe(201);
  return { ...a, sendBack: res.body.data.send_back };
}

describe("request-info hold", () => {
  it("holds the PO at step 2 and keeps step-1 approval", async () => {
    const a = await world.poAtStep2();
    const lifecycleBefore = await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = $1`, [a.poId]);
    const docsBefore = await docRows(a.poId);
    s3Calls.length = 0;

    const res = await world.sendBack(S.APPROVER_A, a.poId, {
      target_role: "RFQ_CREATOR",
      reason_category: "EVIDENCE_MISSING",
      comment: "Please attach the site photos",
      files: [PDF],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(1);

    // The row, in the shape the thread renders.
    const sb = res.body.data.send_back;
    expect(keysOf(sb)).toEqual(SEND_BACK_KEYS);
    expect(sb).toMatchObject({
      route: "INFO_REQUEST",
      reason_category: "EVIDENCE_MISSING",
      comment: "Please attach the site photos",
      requested_by: { id: S.APPROVER_A, name: await world.nameOf(S.APPROVER_A) },
      target_role: "RFQ_CREATOR",
      target: { id: S.CREATOR, name: await world.nameOf(S.CREATOR) },
      status: "OPEN",
      response_text: null,
      responded_by: null,
      responded_at: null,
      resolution: null,
      closed_at: null,
    });
    expect(typeof sb.id).toBe("number");
    expect(sb.files).toHaveLength(1);
    expect(keysOf(sb.files[0])).toEqual(["id", "name", "side", "url"]);
    expect(sb.files[0]).toMatchObject({ side: "REQUEST", name: PDF.name });
    expect(typeof sb.files[0].id).toBe("number");
    // A fresh signed link to the stored object, not the bare object URL.
    expect(sb.files[0].url).toMatch(/^https:\/\/.+\/purchase-order\/send-back\/.+\.pdf\?.*X-Amz-Signature=[0-9a-f]{64}/);

    // The file went through the stubbed client, never the network.
    expect(stubbedSend.name).toBe("stubbedS3Send");
    expect(s3Calls).toEqual([{ op: "PutObjectCommand", key: expect.stringMatching(/^purchase-order\/send-back\/.+\.pdf$/) }]);

    // The approval is untouched: same step, nothing re-opened, nothing decided.
    expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o2 });
    const steps = await db.any(
      `SELECT id, status FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order`,
      [a.instanceId]
    );
    expect(steps.map((s) => s.status)).toEqual(["APPROVED", "PENDING", "PENDING"]);
    const l2 = await db.any(
      `SELECT approver_user_id, status FROM tbl_approval_step_approvers WHERE approval_instance_step_id = $1 ORDER BY approver_user_id`,
      [a.steps.s2]
    );
    expect(l2.map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
    expect((await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).s)
      .toBe("pending_approval");

    // One record of the event: the SEND_BACK action on L2. No lifecycle row, no document.
    const acts = await world.actions(a.instanceId);
    expect(acts.filter((x) => x.action === "SEND_BACK")).toEqual([
      { step_id: a.steps.s2, user_id: S.APPROVER_A, action: "SEND_BACK", comment: "Please attach the site photos" },
    ]);
    expect((await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = $1`, [a.poId])).n)
      .toBe(lifecycleBefore.n);
    expect(await docRows(a.poId)).toEqual(docsBefore);

    const rows = await sendBackRows(db, a.poId);
    expect(rows).toEqual([expect.objectContaining({
      route: "INFO_REQUEST", status: "OPEN", target_role: "RFQ_CREATOR", target_user_id: S.CREATOR,
      requested_by: S.APPROVER_A, approval_instance_step_id: a.steps.s2, step_order: a.steps.o2, closed: false,
    })]);

    // The person asked is told, in the app and by mail, and nobody else is.
    await drainPoSendBackNotifications();
    const told = await notificationsFor(a.poId, "po_send_back_requested");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
    expect(told[0].action_url).toBe(`/dashboard/buyer/purchase-orders/${a.poId}`);
    expect(told[0].message).toContain("Photos or documents missing");
    const holdMails = sentMails.filter((m) => /on hold/i.test(m.subject || ""));
    expect(holdMails.map((m) => m.to)).toEqual([await mailTo(S.CREATOR)]);

    // Anyone who can read the PO sees the same thread.
    const asCreator = await world.thread(S.CREATOR, a.poId);
    expect(asCreator.status).toBe(200);
    expect(asCreator.body.data).toHaveLength(1);
    expect(asCreator.body.data[0]).toMatchObject({ id: sb.id, status: "OPEN" });
  });

  it("blocks approve and reject for both step-2 approvers on both endpoints while open", async () => {
    const a = await heldAtStep2();
    const before = await decisionActions(a.instanceId);
    const docsBefore = await docRows(a.poId);
    const waitingOn = `Waiting on ${await world.nameOf(S.CREATOR)}.`;
    s3Calls.length = 0;

    for (const who of [S.APPROVER_A, S.APPROVER_B]) {
      const attempts = [
        ["page APPROVE", await world.approve(who, a.poId)],
        ["page REJECT", await world.reject(who, a.poId)],
        ["card APPROVE", await world.card(who, a.instanceId, "APPROVE")],
        ["card REJECT", await world.card(who, a.instanceId, "REJECT")],
      ];
      for (const [label, res] of attempts) {
        expect({ label, status: res.status, code: res.body.code, message: res.body.message })
          .toEqual({ label, status: 409, code: "PO_ON_HOLD", message: waitingOn });
      }
    }

    // A second request while one is open is refused the same way.
    const second = await world.sendBack(S.APPROVER_B, a.poId, {
      target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "and the BOQ",
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("PO_ON_HOLD");

    // Nothing moved: still at L2, no decision recorded, no document written.
    expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o2 });
    expect(await decisionActions(a.instanceId)).toEqual(before);
    expect(await docRows(a.poId)).toEqual(docsBefore);
    expect(s3Calls).toEqual([]);
    expect((await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [a.poId])).s)
      .toBe("pending_approval");
    expect((await sendBackRows(db, a.poId)).map((r) => r.status)).toEqual(["OPEN"]);
  });

  it("the RFQ creator answers with a photo and the same step resumes", async () => {
    const a = await heldAtStep2();

    // Neither text nor a file is not an answer.
    const empty = await world.respond(S.CREATOR, a.sendBack.id, {});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("RESPONSE_REQUIRED");
    const blank = await world.respond(S.CREATOR, a.sendBack.id, { response_text: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe("RESPONSE_REQUIRED");

    const res = await world.respond(S.CREATOR, a.sendBack.id, { response_text: "Photos attached", files: [PNG] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const sb = res.body.data.send_back;
    expect(keysOf(sb)).toEqual(SEND_BACK_KEYS);
    expect(sb).toMatchObject({
      id: a.sendBack.id,
      status: "ANSWERED",
      resolution: "RESUMED",
      response_text: "Photos attached",
      responded_by: { id: S.CREATOR, name: await world.nameOf(S.CREATOR) },
    });
    expect(sb.responded_at).toBeTruthy();
    expect(sb.closed_at).toBeTruthy();
    expect(sb.files.map((f) => [f.side, f.name])).toEqual([["REQUEST", PDF.name], ["RESPONSE", PNG.name]]);

    // Answered twice: the second is refused, nothing changes.
    const again = await world.respond(S.CREATOR, a.sendBack.id, { response_text: "again" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("HOLD_NOT_OPEN");

    const acts = await world.actions(a.instanceId);
    expect(acts.filter((x) => x.action.startsWith("SEND_BACK")).map((x) => [x.action, x.user_id])).toEqual([
      ["SEND_BACK", S.APPROVER_A],
      ["SEND_BACK_ANSWERED", S.CREATOR],
    ]);

    // The requester and the step's other pending approver hear about it; the
    // person who answered does not.
    await drainPoSendBackNotifications();
    const told = await notificationsFor(a.poId, "po_send_back_answered");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.APPROVER_A, S.APPROVER_B].sort((x, y) => x - y));
    expect(new Set(told.map((n) => n.action_url))).toEqual(new Set([`/dashboard/buyer/purchase-orders/${a.poId}`]));

    // The same approver approves at the same step; L3 is next and L1 was never asked again.
    const ok = await world.approve(S.APPROVER_A, a.poId);
    expect(ok.status).toBe(200);
    expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o3 });
    const steps = await db.any(
      `SELECT status FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order`, [a.instanceId]);
    expect(steps.map((s) => s.status)).toEqual(["APPROVED", "APPROVED", "PENDING"]);
    const approvals = (await world.actions(a.instanceId)).filter((x) => x.action === "APPROVE");
    expect(approvals.map((x) => [x.step_id, x.user_id])).toEqual([
      [a.steps.s1, S.PO_APPROVER],
      [a.steps.s2, S.APPROVER_A],
    ]);
  });

  it("a second hold can be opened after the first is answered", async () => {
    const a = await heldAtStep2();
    expect((await world.respond(S.CREATOR, a.sendBack.id, { response_text: "done" })).status).toBe(200);

    const res = await world.sendBack(S.APPROVER_B, a.poId, {
      target_role: "RFQ_CREATOR", reason_category: "QTY_SPEC_CHANGE", comment: "Is 50 still right?",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.send_back).toMatchObject({ status: "OPEN", reason_category: "QTY_SPEC_CHANGE", files: [] });

    const list = await world.thread(S.APPROVER_A, a.poId);
    expect(list.status).toBe(200);
    expect(list.body.data.map((r) => [r.id, r.status])).toEqual([
      [res.body.data.send_back.id, "OPEN"],
      [a.sendBack.id, "ANSWERED"],
    ]);
  });

  it("withdraw by the other step-2 approver reopens the step", async () => {
    const a = await heldAtStep2();

    // Someone who can read the PO but is neither the requester nor pending on
    // the step may not withdraw it; another tenant does not see it at all.
    const notAllowed = await world.withdraw(S.PO_APPROVER, a.sendBack.id, "not mine");
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.code).toBe("NOT_ALLOWED");
    expect((await world.withdraw(S.OUTSIDER, a.sendBack.id)).status).toBe(404);

    const res = await world.withdraw(S.APPROVER_B, a.sendBack.id, "Not needed, I checked the file");
    expect(res.status).toBe(200);
    const sb = res.body.data.send_back;
    expect(keysOf(sb)).toEqual(SEND_BACK_KEYS);
    expect(sb).toMatchObject({ id: a.sendBack.id, status: "WITHDRAWN", resolution: null, response_text: null });
    expect(sb.closed_at).toBeTruthy();

    const again = await world.withdraw(S.APPROVER_A, a.sendBack.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("HOLD_NOT_OPEN");
    const late = await world.respond(S.CREATOR, a.sendBack.id, { response_text: "too late" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("HOLD_NOT_OPEN");

    const acts = (await world.actions(a.instanceId)).filter((x) => x.action.startsWith("SEND_BACK"));
    expect(acts.map((x) => [x.action, x.user_id, x.comment])).toEqual([
      ["SEND_BACK", S.APPROVER_A, "Please attach the site photos"],
      ["SEND_BACK_WITHDRAWN", S.APPROVER_B, "Not needed, I checked the file"],
    ]);

    await drainPoSendBackNotifications();
    expect((await notificationsFor(a.poId, "po_send_back_withdrawn")).map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);

    const ok = await world.approve(S.APPROVER_B, a.poId);
    expect(ok.status).toBe(200);
    expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o3 });
  });

  it("an ALL step is frozen for its other approver too, and that approver can withdraw it", async () => {
    const a = await heldAtStep2({ rule: "ALL" });

    const blocked = await world.approve(S.APPROVER_B, a.poId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("PO_ON_HOLD");

    expect((await world.withdraw(S.APPROVER_B, a.sendBack.id)).status).toBe(200);
    const ok = await world.approve(S.APPROVER_B, a.poId);
    expect(ok.status).toBe(200);
    // ALL: still at L2, waiting for APPROVER_A.
    expect(await world.instanceState(a.instanceId)).toEqual({ status: "PENDING", current_step: a.steps.o2 });
  });

  it("answered, then rejected through the reject flow: the thread keeps both", async () => {
    const a = await heldAtStep2();
    expect((await world.respond(S.CREATOR, a.sendBack.id, { response_text: "photos sent" })).status).toBe(200);

    const rejected = await world.reject(S.APPROVER_A, a.poId, { remarks: "price too high", reason_category: "PRICE_TAX_QUERY" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.instance_status).toBe("REJECTED");

    const list = await world.thread(S.INITIATOR, a.poId);
    expect(list.status).toBe(200);
    expect(list.body.data.map((r) => [r.route, r.status, r.reason_category])).toEqual([
      ["COMMERCIAL", "CLOSED", "PRICE_TAX_QUERY"],
      ["INFO_REQUEST", "ANSWERED", "EVIDENCE_MISSING"],
    ]);
    expect(keysOf(list.body.data[0])).toEqual(SEND_BACK_KEYS);
    expect(list.body.data[0]).toMatchObject({ target_role: null, target: null, files: [] });
  });
});

describe("what a send-back request must carry", () => {
  it("refuses rejection reasons, unknown reasons, blank comments, bad targets, the TECHNICAL route and bad files", async () => {
    // APPROVER_A raised the award, so they are this PO's creator: asking
    // PO_INITIATOR would be asking themselves.
    const a = await world.poAtStep2({ raisedBy: S.APPROVER_A });
    const send = (body) => world.sendBack(S.APPROVER_A, a.poId, {
      target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "why?", ...body,
    });
    const refused = async (body, status, code) => {
      const res = await send(body);
      expect({ body, status: res.status, code: res.body.code }).toEqual({ body, status, code });
    };

    await refused({ reason_category: "NOT_REQUIRED" }, 400, "INVALID_REASON");
    await refused({ reason_category: "RENEGOTIATE" }, 400, "INVALID_REASON");
    await refused({ reason_category: "WHATEVER" }, 400, "INVALID_REASON");
    await refused({ comment: "   " }, 400, "COMMENT_REQUIRED");
    await refused({ target_role: "BOSS" }, 400, "INVALID_TARGET");
    await refused({ target_role: "PO_INITIATOR" }, 400, "INVALID_TARGET"); // the caller
    await refused({ target_role: "COMMERCIAL_EVALUATOR" }, 400, "INVALID_TARGET"); // raised the award: the caller again
    await refused({ target_role: "TECHNICAL_EVALUATOR" }, 400, "INVALID_TARGET"); // nobody evaluated
    await refused({ fields: { route: "TECHNICAL" } }, 400, "ROUTE_NOT_AVAILABLE");
    await refused({ files: [TXT] }, 400, "INVALID_FILE");
    await refused({ files: Array.from({ length: 11 }, () => PNG) }, 400, "INVALID_FILE");
    await refused(
      { files: [{ name: "huge.pdf", type: "application/pdf", buffer: Buffer.concat([PDF.buffer, Buffer.alloc(10 * 1024 * 1024)]) }] },
      400, "INVALID_FILE"
    );

    // Nothing was opened by any of them.
    expect(await sendBackRows(db, a.poId)).toEqual([]);
    expect((await world.actions(a.instanceId)).filter((x) => x.action === "SEND_BACK")).toEqual([]);

    // The same request with a real reason and target goes through.
    const ok = await send({ files: [PNG, PDF] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.send_back.files.map((f) => f.side)).toEqual(["REQUEST", "REQUEST"]);
  });

  it("only a pending approver on the current step may ask, and never on a call-off PO", async () => {
    const a = await world.poAtStep2();

    // L1 already approved; the RFQ creator and the L3 approver are not on L2.
    for (const who of [S.PO_APPROVER, S.CREATOR, S.LAST_APPROVER]) {
      const t = await world.targets(who, a.poId);
      expect({ who, status: t.status, code: t.body.code }).toEqual({ who, status: 409, code: "STEP_NOT_PENDING" });
      const c = await world.sendBack(who, a.poId, { target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "?" });
      expect({ who, status: c.status, code: c.body.code }).toEqual({ who, status: 409, code: "STEP_NOT_PENDING" });
    }

    // A concluded approval is not pending for anyone.
    expect((await world.approve(S.APPROVER_A, a.poId)).status).toBe(200);
    expect((await world.approve(S.LAST_APPROVER, a.poId)).status).toBe(200);
    expect((await world.instanceState(a.instanceId)).status).toBe("APPROVED");
    const late = await world.sendBack(S.APPROVER_B, a.poId, { target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "?" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("STEP_NOT_PENDING");

    // A call-off PO (released against a rate contract, no RFQ) in the same
    // business unit: APPROVER_A can read it, and is told plainly it is not
    // available rather than STEP_NOT_PENDING.
    const callOff = await callOffPo();
    try {
      for (const res of [
        await world.targets(S.APPROVER_A, callOff.poId),
        await world.sendBack(S.APPROVER_A, callOff.poId, { target_role: "RFQ_CREATOR", reason_category: "INFO_MISSING", comment: "?" }),
      ]) {
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("CALL_OFF_NOT_SUPPORTED");
      }
      expect(await sendBackRows(db, callOff.poId)).toEqual([]);
    } finally {
      await callOff.cleanup();
    }
  });
});
