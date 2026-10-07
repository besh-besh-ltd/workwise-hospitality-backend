/**
 * `approval:changed` — the push that replaces the 5-second pending-count poll.
 *
 * Contract (app/services/approvalEvents.js, docs/perf/APPROVAL_CHANGED_EVENT.md):
 *   event 'approval:changed', room `user:<id>`, payload { entity_type, entity_id },
 *   sent to every approver on the instance (any status), AFTER the write's
 *   outermost transaction COMMITS — never inside it, never on rollback — and a
 *   failed emit never breaks the write.
 *
 * emitToUser is replaced by a recorder; for every emit it also reads the
 * instance through the TEST pool (a different connection), so a frame sent
 * from inside the transaction would observe the pre-write state.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const emits = [];
let emitShouldThrow = false;
let probe = null; // async (payload) => snapshot taken at emit time

jest.unstable_mockModule("../../app/util/socket.js", () => ({
  emitToUser: (userId, event, payload) => {
    if (emitShouldThrow) throw new Error("socket layer down");
    const rec = { userId: Number(userId), event, payload, seen: null };
    emits.push(rec);
    if (probe && event === "approval:changed") rec.seen = probe(payload);
  },
  emitToCompany: () => {},
  getIo: () => null,
  SocketConfig: () => {},
}));

const { db } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { default: appDb } = await import("../../app/config/dbConn.js");
const { submitApprovalAction, cancelApprovalInstance, createApprovalInstance } =
  await import("../../app/models/generalModel.js");
const { reassignApprover } = await import("../../app/models/approvalOversightModel.js");
const { makeRFQ } = await import("../factories/rfq.js");

const U = IDS.users;
const made = { rfqIds: [], instanceIds: [] };

const until = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const changed = () => emits.filter((e) => e.event === "approval:changed");
const recipients = () => [...new Set(changed().map((e) => e.userId))].sort((a, b) => a - b);

/** RFQ + a PENDING 2-step instance: step 1 ANY [techApp, commApp], step 2 ALL [finance]. */
async function pendingTwoStep() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: U.a1_proc_buyer, status: 3, is_published: 0,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  made.rfqIds.push(rfq_id);
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step, hospitality_company_id, hotel_id,
        department_id, initiated_by, process_id)
     VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7) RETURNING id`,
    [rfq_id, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, U.a1_proc_buyer, IDS.processes.A_P1]);
  made.instanceIds.push(inst.id);
  const s1 = await db.one(`INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
                           VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`, [inst.id]);
  const s2 = await db.one(`INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
                           VALUES ($1, 2, 'ALL', 'PENDING') RETURNING id`, [inst.id]);
  for (const u of [U.a1_proc_techApp, U.a1_proc_commApp]) {
    await db.none(`INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status) VALUES ($1, $2, 'PENDING')`, [s1.id, u]);
  }
  await db.none(`INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status) VALUES ($1, $2, 'PENDING')`, [s2.id, U.a1_proc_finance]);
  return { rfqId: rfq_id, instanceId: inst.id, step1: s1.id, step2: s2.id };
}

afterEach(() => {
  emits.length = 0;
  emitShouldThrow = false;
  probe = null;
});

afterAll(async () => {
  const instIds = (await db.any(
    `SELECT id FROM tbl_approval_instances WHERE id = ANY($1::int[])
        OR (entity_type IN ('RFQ','TENDER') AND entity_id = ANY($2::int[]))`, [made.instanceIds, made.rfqIds])).map((r) => r.id);
  if (instIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instance_change_log WHERE approval_instance_id = ANY($1::int[])`, [instIds]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
  }
  if (made.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [made.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
  }
});

describe("approval:changed", () => {
  it("approving a step tells every approver on the instance — after commit, with the advanced state visible", async () => {
    const { rfqId, instanceId } = await pendingTwoStep();
    probe = (payload) => db.one(`SELECT current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);

    await submitApprovalAction({
      approval_instance_id: instanceId, approver_user_id: U.a1_proc_techApp, action: "APPROVE",
    });

    expect(await until(() => recipients().length === 3)).toBe(true);
    expect(recipients()).toEqual([U.a1_proc_techApp, U.a1_proc_commApp, U.a1_proc_finance].sort((a, b) => a - b));
    for (const e of changed()) {
      expect(e.payload).toEqual({ entity_type: "RFQ", entity_id: rfqId });
      // Read on another connection at emit time: the step had already advanced.
      expect((await e.seen).current_step).toBe(2);
    }
    // Signal only: no counts, no names.
    expect(Object.keys(changed()[0].payload).sort()).toEqual(["entity_id", "entity_type"]);
  });

  it("emits nothing while the caller's transaction is still open, and the moment it commits", async () => {
    const { instanceId } = await pendingTwoStep();
    let emittedInsideTx = null;
    await appDb.tx(async (t) => {
      await submitApprovalAction({
        approval_instance_id: instanceId, approver_user_id: U.a1_proc_techApp, action: "APPROVE",
      }, t);
      await settle(200);
      emittedInsideTx = changed().length;
    });
    expect(emittedInsideTx).toBe(0);
    expect(await until(() => recipients().length === 3)).toBe(true);
  });

  it("emits nothing at all when the transaction rolls back", async () => {
    const { instanceId } = await pendingTwoStep();
    await expect(appDb.tx(async (t) => {
      await submitApprovalAction({
        approval_instance_id: instanceId, approver_user_id: U.a1_proc_techApp, action: "APPROVE",
      }, t);
      throw new Error("caller aborts");
    })).rejects.toThrow("caller aborts");
    await settle(300);
    expect(changed()).toHaveLength(0);
    const row = await db.one(`SELECT current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    expect(row.current_step).toBe(1);
  });

  it("cancelling an instance tells its approvers", async () => {
    const { instanceId } = await pendingTwoStep();
    await cancelApprovalInstance(instanceId, U.a1_proc_buyer, "test");
    expect(await until(() => recipients().length === 3)).toBe(true);
  });

  it("reassigning an approver tells both the outgoing and the incoming approver", async () => {
    const { step1 } = await pendingTwoStep();
    await reassignApprover({ stepId: step1, fromUserId: U.a1_proc_commApp, toUserId: U.a1_proc_poApp, reason: "test" });
    expect(await until(() => recipients().includes(U.a1_proc_poApp))).toBe(true);
    expect(recipients()).toEqual(expect.arrayContaining([U.a1_proc_commApp, U.a1_proc_poApp]));
  });

  it("creating an instance tells its resolved approvers", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: U.a1_proc_buyer, status: 3, is_published: 0,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
    });
    made.rfqIds.push(rfq_id);
    const created = await createApprovalInstance({
      entity_type: "RFQ", entity_id: rfq_id, hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1, department_id: IDS.departments.proc, process_id: IDS.processes.A_P1,
      initiated_by: U.a1_proc_buyer,
    });
    made.instanceIds.push(created.instance.id);
    const approvers = (await db.any(
      `SELECT DISTINCT asa.approver_user_id AS id FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps s ON s.id = asa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`, [created.instance.id])).map((r) => r.id).sort((a, b) => a - b);
    expect(approvers.length).toBeGreaterThan(0);
    expect(await until(() => recipients().length === approvers.length)).toBe(true);
    expect(recipients()).toEqual(approvers);
    for (const e of changed()) expect(e.payload).toEqual({ entity_type: "RFQ", entity_id: rfq_id });
  });

  it("a failing socket layer never breaks the write", async () => {
    const { instanceId } = await pendingTwoStep();
    emitShouldThrow = true;
    const result = await submitApprovalAction({
      approval_instance_id: instanceId, approver_user_id: U.a1_proc_techApp, action: "APPROVE",
    });
    expect(result.instance_status).toBe("PENDING");
    await settle(200);
    const row = await db.one(`SELECT current_step FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    expect(row.current_step).toBe(2);
  });
});
