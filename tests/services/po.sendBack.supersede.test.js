// A hold never outlives the approval it froze (client ticket T3, Task 8).
// ----------------------------------------------------------------------------
// A PO is "on hold" while an OPEN tbl_po_send_backs row exists. Every path that
// ends or reshapes the PO's PENDING approval closes that row in the SAME
// transaction, so no OPEN hold is ever left on an approval nobody can decide:
//
//   the PO is edited (approval restarts at step 1)  SUPERSEDED  PO_AMENDED_RESTARTED
//   the RFQ is closed                               CLOSED      RFQ_CLOSED
//   a policy edit removes, reshapes or moves past   SUPERSEDED  PO_SUPERSEDED
//     the held step
//   the held step's role loses approve              SUPERSEDED  PO_SUPERSEDED
//   the held step loses its last approver           SUPERSEDED  PO_SUPERSEDED
//   the approval is cancelled                       SUPERSEDED  PO_SUPERSEDED
//
// A policy save locks the policy's pending POs before anything else, like
// every PO decision, so the two wait for each other instead of deadlocking.
//
// The person asked is told after commit. Re-finalizing (or approving the award
// of) a product whose PO is held is refused: it would cancel the held PO. The
// person asked is reminded once after 48 hours.
//
// The approval runs on a REAL three-step PO policy for (A, A1, P1), saved and
// edited through the admin endpoint:
//   L1  USER a1_proc_poApp                      (PO_APPROVER)
//   L2  ROLE <hold role>, ANY: APPROVER_A, APPROVER_B (the step that is held)
//   L3  USER a1_proc_techApp                    (L3_APPROVER)
// The fixture PO policy for that tuple is switched off for this suite and put
// back afterwards (one active policy per tuple).
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
const { IDS } = await import("../fixtures/ids.js");
const { makeSendBackWorld, S, sendBackRows } = await import("../helpers/poSendBackWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { drainPoSendBackNotifications } = await import("../../app/services/po/poSendBackNotifier.js");
const { remindOpenHolds } = await import("../../app/services/po/poSendBackService.js");

const world = makeSendBackWorld(db);

const L3_APPROVER = IDS.users.a1_proc_techApp;
const FIXTURE_PO_POLICY = IDS.policies.A1_P1_PO;
const POLICY_ID = 65861;
const ROLE_HOLD = 89361; // the L2 role: awarding read + approve, held by APPROVER_A and APPROVER_B
const ROLE_L3 = 89362; //   makes L3_APPROVER eligible for a USER step (awarding read + approve)
const HOLD_ROLE_TITLE = "TEST PO hold step";
const SUITE_USERS = [L3_APPROVER];
const userBackup = new Map();

const ACTIVE_POLICY_STEPS = [
  { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: S.PO_APPROVER },
  { step_order: 2, decision_rule: "ANY", approver_source_type: "ROLE", approver_source_id: ROLE_HOLD },
  { step_order: 3, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: L3_APPROVER },
];

async function suiteInstanceIds() {
  return (await db.any(`SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1`, [POLICY_ID])).map((r) => r.id);
}

async function clearChangeLogs() {
  const ids = await suiteInstanceIds();
  if (ids.length) {
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE affected_instance_ids && $1::int[]`, [ids]);
  }
  await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE policy_change_log_id IN
                   (SELECT id FROM tbl_approval_policy_change_log WHERE approval_policy_id = $1)`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policy_change_log WHERE approval_policy_id = $1`, [POLICY_ID]);
}

async function resetPolicy() {
  await clearChangeLogs();
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
  for (const s of ACTIVE_POLICY_STEPS) {
    await db.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [POLICY_ID, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id]
    );
  }
}

/** Give the hold role back awarding read + approve (idempotent). */
async function restoreHoldRolePermissions() {
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM tbl_permissions p
      WHERE p.resource::text = 'awarding' AND p.action::text IN ('read', 'approve')
        AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp WHERE rp.role_id = $1 AND rp.permission_id = p.id)`,
    [ROLE_HOLD]
  );
}

async function grantRole(roleId, userIds) {
  for (const u of userIds) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [u, roleId, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc]
    );
  }
}

beforeAll(async () => {
  await world.setup();
  for (const u of SUITE_USERS) {
    userBackup.set(u, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [u]));
  }
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [SUITE_USERS]);

  // The hold role is INITIATOR's own, so INITIATOR may edit its permissions
  // through the role endpoint (system roles, created_by NULL, cannot be edited).
  for (const [id, title, owner] of [[ROLE_HOLD, HOLD_ROLE_TITLE, S.INITIATOR], [ROLE_L3, "TEST PO last step", null]]) {
    await db.none(`INSERT INTO tbl_roles (id, title, description, created_by) VALUES ($1, $2, 'test-only', $3)
                   ON CONFLICT (id) DO UPDATE SET created_by = EXCLUDED.created_by`, [id, title, owner]);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM tbl_permissions p
        WHERE p.resource::text = 'awarding' AND p.action::text IN ('read', 'approve')
          AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp WHERE rp.role_id = $1 AND rp.permission_id = p.id)`,
      [id]
    );
  }
  await grantRole(ROLE_HOLD, [S.APPROVER_A, S.APPROVER_B]);
  await grantRole(ROLE_L3, [L3_APPROVER]);

  await db.none(`UPDATE tbl_approval_policies SET is_active = false WHERE id = $1`, [FIXTURE_PO_POLICY]);
  await db.none(
    `INSERT INTO tbl_approval_policies (id, entity_type, hospitality_company_id, hotel_id, department_id, process_id, is_active, created_by)
     VALUES ($1, 'PO', $2, $3, NULL, $4, true, $5)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [POLICY_ID, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, S.INITIATOR]
  );
  await resetPolicy();
});

afterEach(async () => {
  await drainPoSendBackNotifications();
  await drainPoRejectedNotifications();
  sentMails.length = 0;
  await clearChangeLogs();
  await world.cleanup();
  await resetPolicy();
  await restoreHoldRolePermissions();
});

afterAll(async () => {
  await clearChangeLogs();
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
  await db.none(`UPDATE tbl_approval_policies SET is_active = true WHERE id = $1`, [FIXTURE_PO_POLICY]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [[ROLE_HOLD, ROLE_L3]]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [[ROLE_HOLD, ROLE_L3]]);
  await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [[ROLE_HOLD, ROLE_L3]]);
  for (const [u, b] of userBackup) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u, b.user_type, b.status]);
  }
  await world.teardown();
  await closeDb();
});

// ── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(read, done, { timeout = 6000 } = {}) {
  const end = Date.now() + timeout;
  let last = await read();
  while (!done(last) && Date.now() < end) {
    await sleep(50);
    last = await read();
  }
  return last;
}

const notificationsFor = (poId, type) =>
  db.any(
    `SELECT recipient_user_id, title, message FROM tbl_notifications
      WHERE (additional_data->>'po_id')::int = $1 AND type = $2 ORDER BY id`,
    [poId, type]
  );

const OPEN_ON_DEAD_INSTANCE = `
  SELECT count(*)::int AS n
    FROM tbl_po_send_backs sb
    JOIN tbl_approval_instances ai ON ai.id = sb.approval_instance_id
   WHERE sb.status = 'OPEN' AND ai.status <> 'PENDING'`;

// Nor on a step the approval is no longer waiting on: retired, decided,
// gone, or no longer current. Scoped to this suite's approvals, since other
// suites in the shard write hold rows straight into the table.
const OPEN_ON_DEAD_STEP = `
  SELECT count(*)::int AS n
    FROM tbl_po_send_backs sb
    JOIN tbl_approval_instances ai ON ai.id = sb.approval_instance_id
    LEFT JOIN tbl_approval_instance_steps st ON st.id = sb.approval_instance_step_id
   WHERE sb.status = 'OPEN' AND ai.approval_policy_id = ${POLICY_ID}
     AND (ai.status <> 'PENDING' OR st.id IS NULL OR st.status <> 'PENDING' OR st.step_order <> ai.current_step)`;

async function expectNoHoldOutlivesItsStep() {
  expect((await db.one(OPEN_ON_DEAD_INSTANCE)).n).toBe(0);
  expect((await db.one(OPEN_ON_DEAD_STEP)).n).toBe(0);
}

const holdRow = (id) =>
  db.one(`SELECT id, status, resolution, closed_at IS NOT NULL AS closed, reminded_at FROM tbl_po_send_backs WHERE id = $1`, [id]);

const instanceRow = (id) =>
  db.one(`SELECT id, status, current_step, initiated_by FROM tbl_approval_instances WHERE id = $1`, [id]);

const poRow = (id) =>
  db.one(`SELECT status::text AS status, approval_instance_id, po_number FROM tbl_rfq_purchase_order WHERE id = $1`, [id]);

/** Approvers of an instance step, by order: [user, status] sorted by user. */
async function approversAt(instanceId, order) {
  return (await db.any(
    `SELECT sa.approver_user_id AS u, sa.status
       FROM tbl_approval_step_approvers sa
       JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
      WHERE st.approval_instance_id = $1 AND st.step_order = $2
      ORDER BY sa.approver_user_id`,
    [instanceId, order]
  )).map((r) => [r.u, r.status]);
}

/** The PO stage of the RFQ workspace, read by the CEO-level initiator. */
async function poStage(rfqId) {
  const res = await (await world.client(S.INITIATOR)).get(`/api/v1/rfq/${rfqId}/lifecycle`);
  expect(res.status).toBe(200);
  const stage = res.body.data.stages.find((s) => s.key === "purchase-order");
  const pos = stage.phase.purchase_orders || [];
  return { byId: (id) => pos.find((p) => Number(p.id) === Number(id)) };
}

/**
 * A PO for vendor A on an RFQ both vendors quoted, its award raised by
 * `raisedBy` (so they are the PO's creator and may edit it), initiated by
 * INITIATOR, approved at L1 by PO_APPROVER and put on hold at L2 by `asker`,
 * who asks `target`.
 */
async function heldAtStep2({ raisedBy = S.APPROVER_B, asker = S.APPROVER_A, target = "RFQ_CREATOR" } = {}) {
  const staged = await world.stageRfq({ products: 1, vendors: [S.VENDOR_A, S.VENDOR_B] });
  const product = staged.products[0];
  const { pos } = await world.award(staged, product, [S.VENDOR_A], { raisedBy });
  expect(pos).toHaveLength(1);
  const poId = pos[0].id;
  const instanceId = await world.initiate(poId);

  // The real policy: three live steps, L2 resolved from the hold role.
  expect(await approversAt(instanceId, 1)).toEqual([[S.PO_APPROVER, "PENDING"]]);
  expect(await approversAt(instanceId, 2)).toEqual(
    [[S.APPROVER_A, "PENDING"], [S.APPROVER_B, "PENDING"]].sort((a, b) => a[0] - b[0])
  );
  expect(await approversAt(instanceId, 3)).toEqual([[L3_APPROVER, "PENDING"]]);

  expect((await world.approve(S.PO_APPROVER, poId)).status).toBe(200);
  expect(await instanceRow(instanceId)).toMatchObject({ status: "PENDING", current_step: 2 });

  const res = await world.sendBack(asker, poId, {
    target_role: target, reason_category: "INFO_MISSING", comment: "Which floor is this for?",
  });
  expect(res.status).toBe(201);
  const sendBackId = res.body.data.send_back.id;
  return { ...staged, product, poId, instanceId, sendBackId };
}

const editPo = async (editor, poId, value = "Net 45") =>
  (await world.client(editor)).put(`/api/v1/po/${poId}`).send({ changes: [{ path: "terms_and_conditions", newValue: value }] });

const closeRfq = async (rfqId) =>
  (await world.client(S.CREATOR)).post(`/api/v1/rfq/close-rfq/${rfqId}`).send({ comment: "budget moved" });

/**
 * Run `fn` with INITIATOR as a company administrator. The world makes every
 * buyer user_type 2; the admin endpoints (policy save, user edit) want the
 * legacy admin type, read per request, so it is lent for the call only.
 */
async function asCompanyAdmin(fn) {
  await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [S.INITIATOR]);
  try {
    return await fn(await world.client(S.INITIATOR));
  } finally {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [S.INITIATOR]);
  }
}

/** The admin saves the suite policy with `steps`, confirming the impact on pending approvals. */
const savePolicy = (steps) =>
  asCompanyAdmin((admin) => admin.post("/api/v1/general/hospitality/approval/policies").send({
    id: POLICY_ID,
    entity_type: "PO",
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    process_id: IDS.processes.A_P1,
    is_active: true,
    confirmed_approval_impact: true,
    steps,
  }));

const removeHoldStepFromPolicy = () =>
  savePolicy([ACTIVE_POLICY_STEPS[0], { ...ACTIVE_POLICY_STEPS[2], step_order: 2 }]);

/** Same three levels, same people; only the held level's decision rule changes. */
const reshapeHoldStep = (decision_rule = "ALL") =>
  savePolicy(ACTIVE_POLICY_STEPS.map((s) => (s.step_order === 2 ? { ...s, decision_rule } : s)));

/**
 * The hold role's owner (INITIATOR) edits it through the role endpoint and
 * keeps only awarding.read: the role can no longer approve a PO.
 */
async function stripApproveFromHoldRole() {
  const read = await db.any(
    `SELECT id FROM tbl_permissions WHERE resource::text = 'awarding' AND action::text = 'read' ORDER BY id`
  );
  return (await world.client(S.INITIATOR)).put(`/api/v1/rbac/roles/${ROLE_HOLD}`).send({
    title: HOLD_ROLE_TITLE, description: "test-only", permission_ids: read.map((r) => r.id),
  });
}

/** A user's role scopes, departments and hotel mappings, to put back after an admin edit. */
async function snapshotUser(userId) {
  return {
    userId,
    scopes: await db.any(
      `SELECT role_id, company_id, hotel_id, department_id, process_id FROM tbl_user_role_scopes WHERE user_id = $1 ORDER BY id`,
      [userId]
    ),
    depts: (await db.any(`SELECT department_id FROM tbl_user_department WHERE user_id = $1`, [userId]))
      .map((r) => r.department_id),
    mappings: await db.any(
      `SELECT hospitality_company_id, hospitality_hotel_id, mapping_type FROM tbl_hospitality_user_mappings WHERE user_id = $1`,
      [userId]
    ),
  };
}

async function restoreUser({ userId, scopes, depts, mappings }) {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [userId]);
  for (const s of scopes) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, s.role_id, s.company_id, s.hotel_id, s.department_id, s.process_id]
    );
  }
  await db.none(`DELETE FROM tbl_user_department WHERE user_id = $1`, [userId]);
  for (const d of depts) {
    await db.none(`INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`, [userId, d]);
  }
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [userId]);
  for (const m of mappings) {
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
       VALUES ($1, $2, $3, $4)`,
      [userId, m.hospitality_company_id, m.hospitality_hotel_id, m.mapping_type]
    );
  }
}

/** The admin takes the hold role away from the user in `snap` (user edit endpoint). */
const dropHoldRole = (snap) =>
  asCompanyAdmin((admin) => admin.put("/api/v1/users/update-user-detail").send({
    user_id: snap.userId,
    department_ids: snap.depts,
    confirmed_approval_impact: true,
    roles: snap.scopes.filter((s) => s.role_id !== ROLE_HOLD).map((s) => ({
      role_id: s.role_id, company_id: s.company_id, hotel_id: s.hotel_id,
      department_id: s.department_id, process_id: s.process_id,
    })),
  }));

const BOTH_REMOVED = [[S.APPROVER_A, "REMOVED"], [S.APPROVER_B, "REMOVED"]].sort((a, b) => a[0] - b[0]);

const cancelApproval = async (instanceId) =>
  (await world.client(S.INITIATOR)).post("/api/v1/general/hospitality/approval/cancel")
    .send({ instance_id: instanceId, reason: "raised against the wrong outlet" });

async function finalizeAgain(staged, vendor = S.VENDOR_B) {
  const item = await db.one(
    `SELECT id FROM tbl_quote_items WHERE quote_id = $1 AND variant = $2`,
    [staged.quotes[vendor], staged.product.variant]
  );
  return (await world.client(S.CREATOR)).post("/api/v1/rfq/finalize").send({
    rfq_id: staged.rfq.id, rfq_no: staged.rfq.rfq_no,
    product_variant_id: staged.product.product_variant_id, variant: staged.product.variant,
    vendor_id: vendor, quote_id: item.id, quote_item_id: item.id,
    route_type: "PO", comment: "award it to the other vendor",
    total_value: 25000,
    product_info: {
      rfq_product_id: staged.product.id, quantity: 50, unit: "NOS", unit_price: 500,
      charges_meta: {}, finalized_vendor_id: vendor,
    },
  });
}

const closedCopy = (poNumber, because) =>
  `The request for information on PO ${poNumber} was closed because ${because}.`;

// ── the tests ──────────────────────────────────────────────────────────────

describe("a hold never outlives its approval", () => {
  it("editing a held PO restarts approval at step 1 and supersedes the hold", async () => {
    const h = await heldAtStep2();
    const before = (await notificationsFor(h.poId, "po_approval_needed")).filter((n) => n.recipient_user_id === S.PO_APPROVER).length;

    // APPROVER_B raised the award, so B is the PO's creator and may edit it.
    const res = await editPo(S.APPROVER_B, h.poId);
    expect(res.status).toBe(200);

    // The old approval is gone, the hold with it: superseded, not answered.
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "CANCELLED" });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_AMENDED_RESTARTED", closed: true });
    // One record per event: the CANCELLED action, no closing action for the hold.
    const kinds = (await world.actions(h.instanceId)).map((a) => a.action);
    expect(kinds.filter((k) => k.startsWith("SEND_BACK"))).toEqual(["SEND_BACK"]);
    expect(kinds).toContain("CANCELLED");

    // A fresh approval, at step 1, in the ORIGINAL initiator's name.
    const po = await poRow(h.poId);
    expect(po.status).toBe("pending_approval");
    expect(po.approval_instance_id).not.toBe(h.instanceId);
    const fresh = await instanceRow(po.approval_instance_id);
    expect(fresh).toMatchObject({ status: "PENDING", current_step: 1, initiated_by: S.INITIATOR });
    expect(await approversAt(fresh.id, 1)).toEqual([[S.PO_APPROVER, "PENDING"]]);

    // The step-1 approver is asked again, after the commit.
    const asked = await eventually(
      async () => (await notificationsFor(h.poId, "po_approval_needed")).filter((n) => n.recipient_user_id === S.PO_APPROVER).length,
      (n) => n > before
    );
    expect(asked).toBe(before + 1);

    // The person asked hears it is closed, and why.
    await drainPoSendBackNotifications();
    const told = await notificationsFor(h.poId, "po_send_back_closed");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
    expect(told[0].message).toContain(closedCopy(po.po_number, "the PO was edited"));

    // History is kept per PO, and the PO is no longer shown on hold.
    const thread = await world.thread(S.INITIATOR, h.poId);
    expect(thread.status).toBe(200);
    expect(thread.body.data.map((s) => [s.id, s.status, s.resolution]))
      .toEqual([[h.sendBackId, "SUPERSEDED", "PO_AMENDED_RESTARTED"]]);
    expect((await poStage(h.rfq.id)).byId(h.poId).hold).toBeNull();
    await expectNoHoldOutlivesItsStep();
  });

  it("closing the RFQ closes the hold", async () => {
    // The person asked is the PO's creator (APPROVER_B), not the RFQ creator who closes it.
    const h = await heldAtStep2({ target: "PO_INITIATOR" });
    const res = await closeRfq(h.rfq.id);
    expect(res.status).toBe(200);

    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "CANCELLED" });
    expect((await poRow(h.poId)).status).toBe("cancelled");
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "CLOSED", resolution: "RFQ_CLOSED", closed: true });

    await drainPoSendBackNotifications();
    const told = await notificationsFor(h.poId, "po_send_back_closed");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.APPROVER_B]);
    expect(told[0].message).toContain(closedCopy((await poRow(h.poId)).po_number, "the RFQ was closed"));
    await expectNoHoldOutlivesItsStep();
  });

  it("re-finalizing a product on a held PO is refused", async () => {
    const h = await heldAtStep2();
    const nqBefore = await db.one(
      `SELECT count(*)::int AS n FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = $1`,
      [h.product.id]
    );
    const finalsBefore = await db.any(`SELECT id, vendor_id FROM tbl_quote_finalization WHERE rfq_id = $1 ORDER BY id`, [h.rfq.id]);

    const res = await finalizeAgain(h);
    const { po_number } = await poRow(h.poId);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: 0,
      code: "PO_ON_HOLD",
      message: `PO ${po_number} is waiting for information. Withdraw the request first.`,
    });

    // Nothing moved: no award approval raised, no finalization rewritten, the held PO intact.
    expect((await db.one(
      `SELECT count(*)::int AS n FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = $1`,
      [h.product.id]
    )).n).toBe(nqBefore.n);
    expect(await db.any(`SELECT id, vendor_id FROM tbl_quote_finalization WHERE rfq_id = $1 ORDER BY id`, [h.rfq.id]))
      .toEqual(finalsBefore);
    expect(await poRow(h.poId)).toMatchObject({ status: "pending_approval", approval_instance_id: h.instanceId });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "OPEN" });

    // Withdrawn, the same award goes through.
    expect((await world.withdraw(S.APPROVER_A, h.sendBackId)).status).toBe(200);
    expect((await finalizeAgain(h)).status).toBe(200);
  });

  it("approving the award of a product on a held PO is refused", async () => {
    // An award approval for the same product, raised before the hold.
    const h = await heldAtStep2();
    const award = await world.raiseAward(h, h.product, [S.VENDOR_B]);
    const nqId = award.instance.id;

    const res = await (await world.client(S.COMM_APP)).post(`/api/v1/negotiation/quotes/${h.product.id}/approve`).send({});
    const { po_number } = await poRow(h.poId);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      status: 0,
      code: "PO_ON_HOLD",
      message: `PO ${po_number} is waiting for information. Withdraw the request first.`,
    });

    // The approval did not happen, so nothing is left finalized-but-undrafted.
    expect(await instanceRow(nqId)).toMatchObject({ status: "PENDING" });
    expect((await world.actions(nqId)).filter((a) => a.action === "APPROVE")).toEqual([]);
    expect(await poRow(h.poId)).toMatchObject({ status: "pending_approval", approval_instance_id: h.instanceId });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "OPEN" });
  });

  it("a propagation cancel supersedes the hold", async () => {
    // The admin drops the held level from the policy. Propagation retires the
    // step and moves the approval on to L3; the hold goes with the step.
    const h = await heldAtStep2();
    const res = await removeHoldStepFromPolicy();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const inst = await instanceRow(h.instanceId);
    expect(inst.status).toBe("PENDING");
    expect(inst.current_step).toBe(3);
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });

    await drainPoSendBackNotifications();
    const told = await notificationsFor(h.poId, "po_send_back_closed");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
    expect(told[0].message).toContain(closedCopy((await poRow(h.poId)).po_number, "the approval was restarted"));

    // The new current step's approver can decide: nothing is holding it.
    const ok = await world.approve(L3_APPROVER, h.poId);
    expect(ok.status).toBe(200);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "APPROVED" });
  });

  it("cancelling the approval supersedes the hold", async () => {
    const h = await heldAtStep2();
    const res = await cancelApproval(h.instanceId);
    expect(res.status).toBe(200);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "CANCELLED" });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });
    await expectNoHoldOutlivesItsStep();
  });

  it("a role that can no longer approve retires the held step, and the hold with it", async () => {
    const h = await heldAtStep2();
    const res = await stripApproveFromHoldRole();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);

    // The held level is retired and the approval moves on to L3.
    expect(await approversAt(h.instanceId, 2)).toEqual(BOTH_REMOVED);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 3 });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });
    await expectNoHoldOutlivesItsStep();

    await drainPoSendBackNotifications();
    const told = await notificationsFor(h.poId, "po_send_back_closed");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
    expect(told[0].message).toContain(closedCopy((await poRow(h.poId)).po_number, "the approval was restarted"));

    expect((await world.approve(L3_APPROVER, h.poId)).status).toBe(200);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "APPROVED" });
  });

  it("removing the last approvers of the held step supersedes the hold", async () => {
    const h = await heldAtStep2();
    const a = await snapshotUser(S.APPROVER_A);
    const b = await snapshotUser(S.APPROVER_B);
    try {
      // One approver left on the step: it is still current, and so is the hold.
      expect((await dropHoldRole(a)).status).toBe(200);
      expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 2 });
      expect(await holdRow(h.sendBackId)).toMatchObject({ status: "OPEN" });

      // Nobody left on it: the step is overtaken and the approval moves to L3.
      expect((await dropHoldRole(b)).status).toBe(200);
      expect(await approversAt(h.instanceId, 2)).toEqual(BOTH_REMOVED);
      expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 3 });
      expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });
      await expectNoHoldOutlivesItsStep();

      await drainPoSendBackNotifications();
      const told = await notificationsFor(h.poId, "po_send_back_closed");
      expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
      expect(told[0].message).toContain(closedCopy((await poRow(h.poId)).po_number, "the approval was restarted"));

      expect((await world.approve(L3_APPROVER, h.poId)).status).toBe(200);
      expect(await instanceRow(h.instanceId)).toMatchObject({ status: "APPROVED" });
    } finally {
      await restoreUser(a);
      await restoreUser(b);
    }
  });

  it("changing the held step's decision rule supersedes the hold", async () => {
    // Same step, same people, still current: but the question was asked under
    // a rule that no longer applies, so the hold does not carry over.
    const h = await heldAtStep2();
    const res = await reshapeHoldStep("ALL");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 2 });
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });

    await drainPoSendBackNotifications();
    const told = await notificationsFor(h.poId, "po_send_back_closed");
    expect(told.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);

    // Nothing holds the step any more, and under ALL one approval does not decide it.
    expect((await world.approve(S.APPROVER_A, h.poId)).status).toBe(200);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 2 });
    expect((await world.approve(S.APPROVER_B, h.poId)).status).toBe(200);
    expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 3 });
  });

  it("a policy save waits for a PO being decided before it takes anything the decision needs", async () => {
    // A decision locks the PO, then its approval, then the approval's steps.
    // A policy save that took the policy row and the approval's steps (its
    // policy-step delete nulls their link) and only then waited for the PO
    // would deadlock with it. Here an approver holds the PO, the save starts,
    // and what the approver needs next must still be free.
    const h = await heldAtStep2();
    const freeOrHeld = (t, sql, params) =>
      t.tx((sp) => sp.any(sql, params)).then(
        () => "free",
        (e) => { if (e.code === "55P03") return "held"; throw e; }
      );

    let save = null;
    let seen;
    try {
      seen = await db.tx(async (t) => {
        const { pid } = await t.one(`SELECT pg_backend_pid() AS pid`);
        await t.one(`SELECT id FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`, [h.poId]);
        save = reshapeHoldStep("ALL");
        const waiting = await eventually(
          () => db.any(`SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]),
          (rows) => rows.length > 0
        );
        return {
          waiting,
          locks: {
            policy: await freeOrHeld(t, `SELECT id FROM tbl_approval_policies WHERE id = $1 FOR UPDATE NOWAIT`, [POLICY_ID]),
            approval: await freeOrHeld(t, `SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE NOWAIT`, [h.instanceId]),
            steps: await freeOrHeld(t, `SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 FOR UPDATE NOWAIT`, [h.instanceId]),
          },
        };
      });
    } finally {
      if (save) save = await save; // the approver has let go: the save runs to the end
    }

    // The save waited on the PO row, holding neither the policy nor anything of the approval.
    expect(seen.waiting).toHaveLength(1);
    expect(seen.waiting[0].query).toMatch(/FROM tbl_rfq_purchase_order[\s\S]*FOR UPDATE OF po/);
    expect(seen.locks).toEqual({ policy: "free", approval: "free", steps: "free" });

    expect(save.status).toBe(200);
    expect(save.body.status).toBe(1);
    expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED" });
  });

  it("no OPEN hold survives its step, on any path", async () => {
    // Each hold is checked as soon as its own path has run: a later global
    // path would close a hold an earlier one wrongly left open, hiding it.
    const superseded = async (h) =>
      expect(await holdRow(h.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_SUPERSEDED", closed: true });

    // The targeted paths, together.
    const edited = await heldAtStep2();
    const closed = await heldAtStep2({ target: "PO_INITIATOR" });
    const cancelled = await heldAtStep2();
    expect((await editPo(S.APPROVER_B, edited.poId)).status).toBe(200);
    expect((await closeRfq(closed.rfq.id)).status).toBe(200);
    expect((await cancelApproval(cancelled.instanceId)).status).toBe(200);
    await expectNoHoldOutlivesItsStep();
    expect(await holdRow(edited.sendBackId)).toMatchObject({ status: "SUPERSEDED", resolution: "PO_AMENDED_RESTARTED", closed: true });
    expect(await holdRow(closed.sendBackId)).toMatchObject({ status: "CLOSED", resolution: "RFQ_CLOSED", closed: true });
    await superseded(cancelled);

    // The global paths, one at a time on a freshly held PO: each touches every
    // pending approval of the policy, so the setup is put back in between.
    const propagated = await heldAtStep2();
    expect((await removeHoldStepFromPolicy()).status).toBe(200);
    await expectNoHoldOutlivesItsStep();
    await superseded(propagated);
    await resetPolicy();

    const reshaped = await heldAtStep2();
    expect((await reshapeHoldStep("ALL")).status).toBe(200);
    await expectNoHoldOutlivesItsStep();
    await superseded(reshaped);
    await resetPolicy();

    const roleStripped = await heldAtStep2();
    expect((await stripApproveFromHoldRole()).status).toBe(200);
    await expectNoHoldOutlivesItsStep();
    await superseded(roleStripped);
    await restoreHoldRolePermissions();

    const unstaffed = await heldAtStep2();
    const a = await snapshotUser(S.APPROVER_A);
    const b = await snapshotUser(S.APPROVER_B);
    try {
      expect((await dropHoldRole(a)).status).toBe(200);
      await expectNoHoldOutlivesItsStep();
      expect(await holdRow(unstaffed.sendBackId)).toMatchObject({ status: "OPEN" }); // B is still on the step
      expect((await dropHoldRole(b)).status).toBe(200);
      await expectNoHoldOutlivesItsStep();
      await superseded(unstaffed);
    } finally {
      await restoreUser(a);
      await restoreUser(b);
    }

    // Every hold the seven POs ever had is closed.
    for (const h of [edited, closed, cancelled, propagated, reshaped, roleStripped, unstaffed]) {
      expect((await sendBackRows(db, h.poId)).filter((r) => r.status === "OPEN")).toEqual([]);
    }
  });

  it("a removed requester does not block the step: another pending approver withdraws", async () => {
    const h = await heldAtStep2({ asker: S.APPROVER_A });

    // The admin takes APPROVER_A's hold-step role away. Membership
    // revalidation removes A from L2; B is still on it, so the step and its
    // hold stay where they are.
    const a = await snapshotUser(S.APPROVER_A);
    try {
      const res = await dropHoldRole(a);
      expect(res.status).toBe(200);
      expect(await approversAt(h.instanceId, 2)).toEqual(
        [[S.APPROVER_A, "REMOVED"], [S.APPROVER_B, "PENDING"]].sort((a, b) => a[0] - b[0])
      );
      expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 2 });
      expect(await holdRow(h.sendBackId)).toMatchObject({ status: "OPEN" });

      const out = await world.withdraw(S.APPROVER_B, h.sendBackId, "Not needed, I checked the file");
      expect(out.status).toBe(200);
      expect(await holdRow(h.sendBackId)).toMatchObject({ status: "WITHDRAWN" });
      expect((await world.approve(S.APPROVER_B, h.poId)).status).toBe(200);
      expect(await instanceRow(h.instanceId)).toMatchObject({ status: "PENDING", current_step: 3 });
    } finally {
      await restoreUser(a); // APPROVER_A exactly as they were
    }
  });

  it("reminds the target once after 48h", async () => {
    const due = await heldAtStep2();
    const young = await heldAtStep2();
    // The person asked here (the PO's creator, APPROVER_B) is made inactive below.
    const inactiveTarget = await heldAtStep2({ target: "PO_INITIATOR" });
    await db.none(`UPDATE tbl_po_send_backs SET created_at = now() - interval '49 hours' WHERE id = ANY($1::int[])`,
      [[due.sendBackId, inactiveTarget.sendBackId]]);
    await db.none(`UPDATE tbl_po_send_backs SET created_at = now() - interval '47 hours' WHERE id = $1`, [young.sendBackId]);

    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [S.APPROVER_B]);
    let first;
    try {
      first = await remindOpenHolds(new Date());
    } finally {
      await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [S.APPROVER_B]);
    }
    await drainPoSendBackNotifications();
    expect(first).toEqual({ reminded: 1 });

    const reminders = await notificationsFor(due.poId, "po_send_back_reminder");
    expect(reminders.map((n) => n.recipient_user_id)).toEqual([S.CREATOR]);
    expect(reminders[0].title.length).toBeLessThanOrEqual(255);
    expect(reminders[0].title).toContain((await poRow(due.poId)).po_number);
    expect((await holdRow(due.sendBackId)).reminded_at).not.toBeNull();
    const mails = sentMails.filter((m) => /Reminder/.test(m.subject || ""));
    expect(mails.map((m) => m.to)).toEqual([(await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [S.CREATOR])).email]);

    // Not 48h old yet: nothing. Inactive target: skipped, left to remind later.
    expect(await notificationsFor(young.poId, "po_send_back_reminder")).toEqual([]);
    expect((await holdRow(young.sendBackId)).reminded_at).toBeNull();
    expect(await notificationsFor(inactiveTarget.poId, "po_send_back_reminder")).toEqual([]);
    expect((await holdRow(inactiveTarget.sendBackId)).reminded_at).toBeNull();

    // Once only: a second run sends nothing more for the held PO already reminded.
    const second = await remindOpenHolds(new Date());
    await drainPoSendBackNotifications();
    expect(second).toEqual({ reminded: 1 }); // the formerly inactive target, now active again
    expect(await notificationsFor(due.poId, "po_send_back_reminder")).toHaveLength(1);
    expect(await notificationsFor(inactiveTarget.poId, "po_send_back_reminder")).toHaveLength(1);
    expect(await remindOpenHolds(new Date())).toEqual({ reminded: 0 });
  });

  it("does not remind a target who can no longer see the PO", async () => {
    const h = await heldAtStep2({ target: "PO_INITIATOR" }); // APPROVER_B
    await db.none(`UPDATE tbl_po_send_backs SET created_at = now() - interval '49 hours' WHERE id = $1`, [h.sendBackId]);
    // B loses every grant that lets them read the PO.
    const scopes = await db.any(`SELECT * FROM tbl_user_role_scopes WHERE user_id = $1`, [S.APPROVER_B]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [S.APPROVER_B]);
    let out;
    try {
      out = await remindOpenHolds(new Date());
    } finally {
      for (const s of scopes) {
        await db.none(
          `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.user_id, s.role_id, s.company_id, s.hotel_id, s.department_id, s.process_id]
        );
      }
    }
    await drainPoSendBackNotifications();
    expect(out).toEqual({ reminded: 0 });
    expect(await notificationsFor(h.poId, "po_send_back_reminder")).toEqual([]);
    expect((await holdRow(h.sendBackId)).reminded_at).toBeNull();
  });
});
