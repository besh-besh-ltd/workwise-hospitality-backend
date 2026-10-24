// Stock adjustments (Task C3, spec §8.4): auto-approval under the company
// limit, approval by inventory.approve holders, and the self-approval rule.
//
// The service cases run inside withTx. The approval flow goes through HTTP
// (controller, notification after commit) and commits, so the suite
// truncates the dynamic tables before and after and revokes its grants.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  CO, A1, STORE, STORE_ID, CTRL, CTRL_ID, CTRL2, CTRL2_ID, grant, grantCast, makeItem, stockIn, move, balanceOf,
  movementsOf, setCompanySettings, thrownBy,
} from "../helpers/invStockFixtures.js";
import { startCount, cancelCount } from "../../app/services/inventory/countService.js";
import {
  createAdjustment, approveAdjustment, rejectAdjustment, getAdjustment, listAdjustments,
} from "../../app/services/inventory/adjustmentService.js";
import { drainApprovalNotices } from "../../app/services/inventory/notices/approvalNotices.js";

/** The newest activity event for an entity, polled: capture runs after the response. */
async function activityEvent(entityType, entityId, eventKey, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT event_key, hospitality_company_id, hotel_id, entity_label FROM tbl_activity_events
        WHERE entity_type = $1 AND entity_id = $2 AND event_key = $3 ORDER BY id DESC LIMIT 1`,
      [entityType, String(entityId), eventKey]
    );
    if (row || Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const adj = (over = {}) => ({ hotelId: A1, reasonCode: "WASTAGE", submit: true, clientEventId: randomUUID(), ...over });

beforeAll(async () => {
  await truncateDynamic();
});

afterAll(async () => {
  await truncateDynamic();
  await closeDb();
});

describe("adjustments", () => {
  it("adjustment under auto-approve limit posts immediately", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await setCompanySettings(t, { autoApproveLimit: 400 });
      const item = await makeItem(t, { name: "Eggs" });
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 50 });

      const { adjustment, replayed, needsApproval } = await createAdjustment(t, STORE, adj({
        remarks: "Dropped tray", lines: [{ invItemId: item, qty: -3, remarks: "cracked" }],
      }));
      expect(replayed).toBe(false);
      expect(needsApproval).toBe(false);
      expect(adjustment).toMatchObject({ status: "posted", reasonCode: "WASTAGE", hotelId: A1, value: 150 });
      expect(adjustment.adjustmentNumber).toMatch(/^ADJ\/10101\/\d{4}-\d{2}\/00001$/);
      expect(adjustment.lines).toEqual([
        expect.objectContaining({ invItemId: item, displayName: "Eggs", qty: -3, unitCost: 50, value: -150, remarks: "cracked" }),
      ]);
      expect(await movementsOf(t, { sourceType: "ADJ", sourceId: adjustment.id })).toEqual([
        expect.objectContaining({ type: "ADJUST_OUT", qty: -3, unit_cost: 50, reason_code: "WASTAGE" }),
      ]);
      expect((await balanceOf(t, A1, item)).qty).toBe(7);

      // FOUND stock comes back in at the average
      const { adjustment: found } = await createAdjustment(t, STORE, adj({ reasonCode: "FOUND", lines: [{ invItemId: item, qty: 2 }] }));
      expect(found.status).toBe("posted");
      expect(await movementsOf(t, { sourceType: "ADJ", sourceId: found.id })).toEqual([
        expect.objectContaining({ type: "ADJUST_IN", qty: 2, unit_cost: 50 }),
      ]);

      // above the limit, or not submitted: waits for approval, stock untouched
      const { adjustment: big, needsApproval: waits } = await createAdjustment(t, STORE, adj({ lines: [{ invItemId: item, qty: -9 }] }));
      expect(waits).toBe(true);
      expect(big).toMatchObject({ status: "pending_approval", value: 450 });
      const { adjustment: held } = await createAdjustment(t, STORE, adj({ submit: false, lines: [{ invItemId: item, qty: -1 }] }));
      expect(held.status).toBe("pending_approval");
      expect((await balanceOf(t, A1, item)).qty).toBe(9);

      // a limit of 0 (the default) means every adjustment needs approval
      await setCompanySettings(t, { autoApproveLimit: 0 });
      const { adjustment: tiny } = await createAdjustment(t, STORE, adj({ lines: [{ invItemId: item, qty: -1 }] }));
      expect(tiny.status).toBe("pending_approval");

      // signs follow the reason; OPENING is internal
      for (const [reasonCode, qty] of [["WASTAGE", 1], ["FOUND", -1], ["OPENING", -1], ["CORRECTION", 0]]) {
        const err = await thrownBy(t, (sp) => createAdjustment(sp, STORE, adj({ reasonCode, lines: [{ invItemId: item, qty }] })));
        expect([reasonCode, err.code]).toEqual([reasonCode, "VALIDATION"]);
      }
      // the same clientEventId answers the first adjustment again
      const key = randomUUID();
      const one = await createAdjustment(t, STORE, adj({ clientEventId: key, lines: [{ invItemId: item, qty: -1 }] }));
      const two = await createAdjustment(t, STORE, adj({ clientEventId: key, lines: [{ invItemId: item, qty: -5 }] }));
      expect(two).toMatchObject({ replayed: true });
      expect(two.adjustment.id).toBe(one.adjustment.id);

      const list = await listAdjustments(t, STORE, { hotelId: A1, status: "pending_approval" });
      expect(list.rows.map((r) => r.id)).toEqual(expect.arrayContaining([big.id, held.id, tiny.id]));
      expect(list.rows.every((r) => r.status === "pending_approval")).toBe(true);
    });
  });

  it("only approvers approve or reject; a sole approver may approve their own", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 20 });

      const { adjustment } = await createAdjustment(t, STORE, adj({ reasonCode: "THEFT_LOSS", lines: [{ invItemId: item, qty: -2 }] }));
      const noRight = await thrownBy(t, (sp) => approveAdjustment(sp, STORE, adjustment.id));
      expect(noRight.code).toBe("FORBIDDEN");
      const noRight2 = await thrownBy(t, (sp) => rejectAdjustment(sp, STORE, adjustment.id, "no"));
      expect(noRight2.code).toBe("FORBIDDEN");
      expect((await getAdjustment(t, STORE, adjustment.id)).can).toEqual({ approve: false, reject: false });
      expect((await getAdjustment(t, CTRL, adjustment.id)).can).toEqual({ approve: true, reject: true });

      // CTRL is the only approver at the hotel: their own adjustment is theirs to approve
      const { adjustment: own } = await createAdjustment(t, CTRL, adj({ lines: [{ invItemId: item, qty: -1 }] }));
      expect((await getAdjustment(t, CTRL, own.id)).can.approve).toBe(true);
      const posted = await approveAdjustment(t, CTRL, own.id);
      expect(posted).toMatchObject({ status: "posted", approvedBy: CTRL_ID });
      expect((await balanceOf(t, A1, item)).qty).toBe(9);

      // reject needs a reason
      const blank = await thrownBy(t, (sp) => rejectAdjustment(sp, CTRL, adjustment.id, "  "));
      expect(blank.code).toBe("VALIDATION");
      const rejected = await rejectAdjustment(t, CTRL, adjustment.id, "Recount first");
      expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Recount first" });
      const again = await thrownBy(t, (sp) => approveAdjustment(sp, CTRL, adjustment.id));
      expect(again.code).toBe("CONFLICT");
      expect((await balanceOf(t, A1, item)).qty).toBe(9);
    });
  });
});

describe("freeze and cost guards", () => {
  it("the freeze blocks approving an adjustment while a count is open", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const item = await makeItem(t);
      await stockIn(t, { invItemId: item, qty: 10, unitCost: 20 });
      const { adjustment } = await createAdjustment(t, STORE, adj({ lines: [{ invItemId: item, qty: -2 }] }));
      expect(adjustment.status).toBe("pending_approval");

      const count = await startCount(t, STORE, { hotelId: A1, scope: "SELECTED", invItemIds: [item] });
      await setCompanySettings(t, { countFreeze: true });
      const locked = await thrownBy(t, (sp) => approveAdjustment(sp, CTRL, adjustment.id));
      expect(locked.code).toBe("LOCKED");
      expect(locked.details).toMatchObject({ countId: count.id });
      expect((await getAdjustment(t, CTRL, adjustment.id)).status).toBe("pending_approval");

      await cancelCount(t, CTRL, count.id);
      expect((await approveAdjustment(t, CTRL, adjustment.id)).status).toBe("posted");
      expect((await balanceOf(t, A1, item)).qty).toBe(8);
    });
  });

  it("a gain needs a cost here, and stock on hand at an average of 0 takes it at 0", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await setCompanySettings(t, { autoApproveLimit: 100000 });
      const never = await makeItem(t, { name: "Never stocked" });
      const used = await makeItem(t, { name: "Used up at 0" });
      await move(t, { invItemId: used, type: "COUNT_IN", qty: 2, unitCost: 0 });
      await move(t, { invItemId: used, type: "ADJUST_OUT", qty: -2 });
      expect(await balanceOf(t, A1, used)).toEqual({ qty: 0, avgCost: 0, value: 0 });

      for (const [invItemId, reasonCode] of [[never, "FOUND"], [used, "FOUND"]]) {
        const err = await thrownBy(t, (sp) => createAdjustment(sp, STORE, adj({ reasonCode, lines: [{ invItemId, qty: 1 }] })));
        expect(err.code).toBe("VALIDATION");
        expect(err.details).toEqual({ field: "lines", index: 0, invItemId });
        expect(err.message).toMatch(/has no cost at this hotel yet/);
      }

      // Zero-cost stock on hand (samples, a 0-cost opening) is a real cost of 0.
      const free = await makeItem(t, { name: "Zero cost" });
      await move(t, { invItemId: free, type: "COUNT_IN", qty: 5, unitCost: 0 });
      const { adjustment, needsApproval } = await createAdjustment(t, STORE, adj({
        reasonCode: "CORRECTION", lines: [{ invItemId: free, qty: 1 }],
      }));
      expect(needsApproval).toBe(false);
      expect(adjustment.status).toBe("posted");
      expect(await movementsOf(t, { sourceType: "ADJ", sourceId: adjustment.id })).toEqual([
        expect.objectContaining({ type: "ADJUST_IN", inv_item_id: free, qty: 1, unit_cost: 0, value: 0 }),
      ]);
      expect(await balanceOf(t, A1, free)).toEqual({ qty: 6, avgCost: 0, value: 0 });
    });
  });
});

describe("approval over HTTP (committed)", () => {
  const scopes = [];
  let item;

  beforeAll(async () => {
    scopes.push(...(await grantCast(db)));
    scopes.push(await grant(db, CTRL2_ID, "Inventory Controller", { hotelId: A1 }));
    await setCompanySettings(db, { autoApproveLimit: 100 });
    item = await makeItem(db, { name: "Glassware" });
    await db.tx((t) => stockIn(t, { invItemId: item, qty: 10, unitCost: 100 }));
  });
  afterAll(async () => {
    await drainApprovalNotices();
    await revokeRoleScopes(db, scopes);
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = ANY($1::text[])`, [["INV_ADJUSTMENT"]]);
  });

  it("adjustment above limit waits for approval; approver posts it; self-approval blocked when another approver exists", async () => {
    const ctrl = await httpClient(CTRL_ID);
    const ctrl2 = await httpClient(CTRL2_ID);
    const store = await httpClient(STORE_ID);

    const created = await ctrl.post("/api/v1/inventory/adjustments").send(
      adj({ reasonCode: "BREAKAGE", lines: [{ invItemId: item, qty: -5 }] })
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "pending_approval", value: 500 });
    const id = created.body.data.id;
    expect((await balanceOf(db, A1, item)).qty).toBe(10);

    // the other approver is told; the creator is not
    await drainApprovalNotices();
    const notified = await db.any(
      `SELECT recipient_user_id FROM tbl_notifications WHERE type = 'inventory_approval_needed'
          AND (additional_data->>'adjustmentId')::int = $1`,
      [id]
    );
    expect(notified.map((n) => Number(n.recipient_user_id))).toEqual([CTRL2_ID]);

    const self = await ctrl.post(`/api/v1/inventory/adjustments/${id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ status: 0, code: "FORBIDDEN", details: { reason: "SELF_APPROVAL" } });

    const storekeeper = await store.post(`/api/v1/inventory/adjustments/${id}/approve`);
    expect(storekeeper.status).toBe(403);

    const approved = await ctrl2.post(`/api/v1/inventory/adjustments/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "posted", approvedBy: CTRL2_ID });
    expect((await balanceOf(db, A1, item)).qty).toBe(5);
    expect(await movementsOf(db, { sourceType: "ADJ", sourceId: id })).toEqual([
      expect.objectContaining({ type: "ADJUST_OUT", qty: -5, unit_cost: 100, reason_code: "BREAKAGE" }),
    ]);

    const twice = await ctrl2.post(`/api/v1/inventory/adjustments/${id}/approve`);
    expect(twice.status).toBe(409);
    expect((await balanceOf(db, A1, item)).qty).toBe(5);

    // the activity trail records the approval with the hotel's scope
    const trail = await activityEvent("INV_ADJUSTMENT", id, "inventory_adjustment_approved");
    expect(trail).toMatchObject({ hospitality_company_id: CO, hotel_id: A1, entity_label: created.body.data.adjustmentNumber });
  });

  it("two concurrent approvals of one adjustment: one posts, the other is CONFLICT", async () => {
    // 2 × 100 is over this describe's auto-approve limit of 100
    const { adjustment } = await db.tx((t) => createAdjustment(t, CTRL, adj({ lines: [{ invItemId: item, qty: -2 }] })));
    expect(adjustment.status).toBe("pending_approval");
    const before = (await balanceOf(db, A1, item)).qty;
    const results = await Promise.allSettled([
      db.tx((t) => approveAdjustment(t, CTRL2, adjustment.id)),
      db.tx((t) => approveAdjustment(t, CTRL2, adjustment.id)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "fulfilled").value.status).toBe("posted");
    const refused = results.find((r) => r.status === "rejected").reason;
    expect(refused.code).toBe("CONFLICT");
    expect(refused.details).toEqual({ status: "posted" });
    expect(await movementsOf(db, { sourceType: "ADJ", sourceId: adjustment.id })).toHaveLength(1);
    expect((await balanceOf(db, A1, item)).qty).toBe(before - 2);
  });

  it("a role without inventory.read cannot see an adjustment at all", async () => {
    const custom = Number((await db.one(
      `INSERT INTO tbl_roles (title, description, created_by) VALUES ('C3 grn only', 'inventory.adjustments test', $1) RETURNING id`,
      [STORE_ID]
    )).id);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, id FROM tbl_permissions WHERE resource::text = 'grn' AND action::text = 'read'`,
      [custom]
    );
    const recv = IDS.users.a1_proc_techEval; // grn.read only, in company A
    const scope = await grantRoleScope(db, { userId: recv, roleId: custom, companyId: CO });
    try {
      const { adjustment } = await db.tx((t) => createAdjustment(t, STORE, adj({ lines: [{ invItemId: item, qty: -1 }] })));
      const c = await httpClient(recv);
      const res = await c.get(`/api/v1/inventory/adjustments/${adjustment.id}`);
      expect(res.status).toBe(404);
      const act = await c.post(`/api/v1/inventory/adjustments/${adjustment.id}/approve`);
      expect(act.status).toBe(404);
    } finally {
      await revokeRoleScopes(db, [scope]);
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [custom]);
      await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [custom]);
    }
  });
});
