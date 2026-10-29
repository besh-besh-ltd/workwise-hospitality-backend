// A PO an approver can put on hold by asking a named person for information
// (client ticket T3), for the po.sendBack.* and rfq.lifecycle.poHold suites.
//
// Built on poRejectWorld: the RFQ, the award and the Initiate all run through
// the real flows. The one thing written by hand is the approval's shape: the
// fixture PO policy resolves to a single live step, so threeSteps() adds two
// more, the way po.approve.guards does:
//
//   L1  PO_APPROVER                       (the step initiate created)
//   L2  APPROVER_A + APPROVER_B, ANY|ALL  (the step that gets held)
//   L3  LAST_APPROVER
//
// Who is who, besides poRejectWorld's cast:
//   APPROVER_A     a1_proc_commApp   L2, reads the PO (COMM_APPROVER)
//   APPROVER_B     a1_proc_finance   L2, reads the PO (TENDER_APPROVER: rfq.read)
//   LAST_APPROVER  companyA_admin    L3
//   TECH_EVAL      a1_proc_techEval  cannot read POs (TECH_EVAL / TECH_APPROVER)
//   OUTSIDER       companyB_admin    another tenant's CEO
//
// Mail never leaves the machine: callers mock nodemailer before importing the
// app, and S3 is stubbed for every suite in tests/setup/jestEnv.js.

import { expect } from "@jest/globals";
import { IDS } from "../fixtures/ids.js";
import { makePoRejectWorld, W } from "./poRejectWorld.js";

export const S = Object.freeze({
  ...W,
  APPROVER_A: W.COMM_APP,
  APPROVER_B: IDS.users.a1_proc_finance,
  LAST_APPROVER: W.INITIATOR,
  TECH_EVAL: IDS.users.a1_proc_techEval,
  OUTSIDER: IDS.users.companyB_admin,
});

const EXTRA_BUYERS = [S.APPROVER_B, S.TECH_EVAL, S.OUTSIDER];

// A 1x1 PNG and a minimal PDF: real magic bytes, so content sniffing agrees.
export const PNG = Object.freeze({
  name: "site-photo.png",
  type: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  ),
});
export const PDF = Object.freeze({
  name: "vendor-quote.pdf",
  type: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
});
export const TXT = Object.freeze({ name: "notes.txt", type: "text/plain", buffer: Buffer.from("plain text") });

export function makeSendBackWorld(db) {
  const base = makePoRejectWorld(db);
  const backup = new Map();
  const extraInstanceIds = [];

  async function setup() {
    await base.setup();
    for (const u of EXTRA_BUYERS) {
      backup.set(u, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [u]));
    }
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [EXTRA_BUYERS]);
  }

  async function teardown() {
    for (const [u, b] of backup) {
      await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u, b.user_type, b.status]);
    }
    await base.teardown();
  }

  async function cleanup() {
    const ids = extraInstanceIds.splice(0);
    if (ids.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
    }
    await base.cleanup();
  }

  /** An approval instance written by the test (not a PO's); removed by cleanup. */
  function trackInstance(id) {
    extraInstanceIds.push(Number(id));
  }

  /**
   * Turn the PO's one-step approval into L1 (as created) + L2 (APPROVER_A and
   * APPROVER_B under `rule`) + L3 (LAST_APPROVER). Returns the three step ids.
   */
  async function threeSteps(instanceId, { rule = "ANY" } = {}) {
    const steps = await db.any(
      `SELECT id, step_order FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order`,
      [instanceId]
    );
    expect(steps).toHaveLength(1);
    const first = steps[0];
    const step2 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
      [instanceId, first.step_order + 1, rule]
    );
    for (const u of [S.APPROVER_A, S.APPROVER_B]) {
      await db.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'PENDING')`,
        [step2.id, u]
      );
    }
    const step3 = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, $2, 'ANY', 'PENDING') RETURNING id`,
      [instanceId, first.step_order + 2]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [step3.id, S.LAST_APPROVER]
    );
    return {
      s1: Number(first.id), s2: Number(step2.id), s3: Number(step3.id),
      o1: first.step_order, o2: first.step_order + 1, o3: first.step_order + 2,
    };
  }

  /**
   * A PO for vendor A on an RFQ both vendors quoted, initiated, reshaped to
   * three steps and approved at L1 by PO_APPROVER: it now waits at L2.
   */
  async function poAtStep2({ rule = "ANY", raisedBy } = {}) {
    const staged = await base.stageRfq({ products: 1, vendors: [S.VENDOR_A, S.VENDOR_B] });
    const product = staged.products[0];
    const { pos, approvalInstanceId } = await base.award(staged, product, [S.VENDOR_A]);
    expect(pos).toHaveLength(1);
    const poId = pos[0].id;
    if (raisedBy != null) {
      // `raisedBy` raised the award, so they are its commercial evaluator and
      // the drafted PO's creator. Rewritten after the fact: the award's own
      // approver (COMM_APP) may not approve an award they raised themselves.
      await db.none(`UPDATE tbl_approval_instances SET initiated_by = $2 WHERE id = $1`, [approvalInstanceId, raisedBy]);
      await db.none(`UPDATE tbl_rfq_purchase_order SET initiated_by = $2 WHERE id = $1`, [poId, raisedBy]);
    }
    const instanceId = await base.initiate(poId);
    const steps = await threeSteps(instanceId, { rule });
    const l1 = await approve(S.PO_APPROVER, poId);
    expect(l1.status).toBe(200);
    expect(await instanceState(instanceId)).toEqual({ status: "PENDING", current_step: steps.o2 });
    return { ...staged, product, poId, instanceId, steps };
  }

  const as = (userId) => base.client(userId);

  async function sendBack(userId, poId, { target_role, reason_category, comment, files = [], fields = {} } = {}) {
    let req = (await as(userId)).post(`/api/v1/po/${poId}/send-back`);
    for (const [k, v] of Object.entries({ target_role, reason_category, comment, ...fields })) {
      if (v !== undefined && v !== null) req = req.field(k, String(v));
    }
    for (const f of files) req = req.attach("files", f.buffer, { filename: f.name, contentType: f.type });
    return req;
  }

  async function respond(userId, sendBackId, { response_text, files = [] } = {}) {
    let req = (await as(userId)).post(`/api/v1/po/send-back/${sendBackId}/respond`);
    if (response_text !== undefined) req = req.field("response_text", String(response_text));
    for (const f of files) req = req.attach("files", f.buffer, { filename: f.name, contentType: f.type });
    // A multipart body even with nothing in it, as the browser sends.
    if (response_text === undefined && !files.length) req = req.field("_", "");
    return req;
  }

  async function withdraw(userId, sendBackId, note) {
    return (await as(userId)).post(`/api/v1/po/send-back/${sendBackId}/withdraw`).send(note ? { note } : {});
  }

  async function targets(userId, poId) {
    return (await as(userId)).get(`/api/v1/po/${poId}/send-back/targets`);
  }

  async function thread(userId, poId) {
    return (await as(userId)).get(`/api/v1/po/${poId}/send-backs`);
  }

  async function approve(userId, poId) {
    return (await as(userId)).post(`/api/v1/po/approve/${poId}`).send({ decision: "approved", remarks: "ok" });
  }

  async function reject(userId, poId, { remarks = "no", reason_category = "PRICE_TAX_QUERY" } = {}) {
    return (await as(userId)).post(`/api/v1/po/approve/${poId}`).send({ decision: "rejected", remarks, reason_category });
  }

  /** APPROVE or REJECT on the generic approval card, at the current step. */
  async function card(userId, instanceId, action, extra = {}) {
    return (await as(userId)).post(`/api/v1/general/hospitality/approval/action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: await base.currentStepId(instanceId),
      action,
      comment: "card",
      ...(action === "REJECT" ? { reason_category: "PRICE_TAX_QUERY" } : {}),
      ...extra,
    });
  }

  async function instanceState(instanceId) {
    return db.one(`SELECT status, current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
  }

  /** Every approval action on the instance, oldest first. */
  async function actions(instanceId) {
    return db.any(
      `SELECT approval_instance_step_id AS step_id, approver_user_id AS user_id, action, comment
         FROM tbl_approval_actions WHERE approval_instance_id = $1 ORDER BY id`,
      [instanceId]
    );
  }

  async function nameOf(userId) {
    return (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [userId])).name;
  }

  return {
    ...base,
    setup, teardown, cleanup, trackInstance, threeSteps, poAtStep2,
    sendBack, respond, withdraw, targets, thread, approve, reject, card,
    instanceState, actions, nameOf,
  };
}

/** The sorted keys of an object, for exact-shape assertions. */
export const keysOf = (o) => Object.keys(o || {}).sort();

/** The send-back rows of a PO, oldest first, straight from the table. */
export const sendBackRows = (db, poId) =>
  db.any(
    `SELECT id, route, status, resolution, target_role, target_user_id, requested_by, responded_by,
            response_text, comment, reason_category, approval_instance_step_id, step_order,
            closed_at IS NOT NULL AS closed
       FROM tbl_po_send_backs WHERE purchase_order_id = $1 ORDER BY id`,
    [poId]
  );
