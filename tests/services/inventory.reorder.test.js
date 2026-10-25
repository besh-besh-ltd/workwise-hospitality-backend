// Reorder (Task D3, spec §9): the worklist (on hand, on order, open MR
// quantity, suggested quantity, contracted lines at the rate the MR stores),
// "Create MR draft" for contracted items (within the contract's remaining
// quantity, idempotent on clientEventId), and the daily low-stock digest.
//
// Service cases run inside withTx. The HTTP cases and the digest's real
// notifier commit, so the suite truncates the dynamic tables before and after
// and deletes the MR / ARC / notification rows it committed.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { randomUUID } from "crypto";
import { db, withTx, closeDb, truncateDynamic } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  CO, A1, A2, FB, HK, STORE, STORE_ID, CTRL, CTRL_ID, FOREIGN, FOREIGN_ID, grantCast, makeItem, setLevels,
  stockIn, thrownBy, roleId,
} from "../helpers/invStockFixtures.js";
import { makeRfqPo, setPlan } from "../helpers/invReceiptFixtures.js";
import {
  getReorderList, createReorderMrDraft, runLowStockSweep,
} from "../../app/services/inventory/reorderService.js";
import { assertUserHasScope } from "../../app/services/authorizationService.js";

const ENG = IDS.departments.eng;
const VENDOR = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const DAY = "2030-03-15";

let V = []; // seeded product variant ids

beforeAll(async () => {
  await truncateDynamic();
  V = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 8`)).map((r) => Number(r.id));
});

afterAll(async () => {
  await truncateDynamic();
  await closeDb();
});

let seq = 0;
const tag = () => `inv-d3-${process.pid}-${++seq}`;

/**
 * mr.create (the system "MR Raiser" role) for a buyer at A1: one department,
 * or every one (departmentId null). An MR draft needs it at the exact
 * department; Storekeeper and Inventory Controller do not carry it.
 */
const grantMr = async (t, userId = STORE_ID, { hotelId = A1, departmentId = null, processId = null } = {}) =>
  grantRoleScope(t, { userId, roleId: await roleId(t, "MR Raiser"), companyId: CO, hotelId, departmentId, processId });

async function mapVariant(t, invItemId, variantId) {
  await t.none(
    `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id) VALUES ($1, $2, $3)`,
    [CO, invItemId, variantId]
  );
}

async function itemWith(t, { name, stockUom = "litre", variantId = null, reorderLevel = null, maxQty = null, qty = 0, hotelId = A1 }) {
  const id = await makeItem(t, { name, stockUom });
  if (variantId) await mapVariant(t, id, variantId);
  if (reorderLevel != null || maxQty != null) await setLevels(t, { hotelId, invItemId: id, reorderLevel, maxQty });
  if (qty) await stockIn(t, { hotelId, invItemId: id, qty, unitCost: 10 });
  return id;
}

async function setUom(t, invItemId, uomLabel, factor) {
  await t.none(
    `INSERT INTO tbl_inv_item_uom (hospitality_company_id, inv_item_id, uom_label, factor_to_stock) VALUES ($1, $2, $3, $4)`,
    [CO, invItemId, uomLabel, factor]
  );
}

async function addBarcode(t, invItemId, packFactor) {
  await t.none(
    `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code, pack_factor, source)
     VALUES ($1, $2, $3, $4, 'INTERNAL')`,
    [CO, invItemId, `BC-${tag()}`, packFactor]
  );
}

/**
 * An ARC at the hotel and department with one active contract; lines
 * [{variantId, unitRate, uom}], each committing committedQty with consumedQty
 * used. group {[hotelId]: {committedQty, consumedQty, rateOverride}} makes it
 * a group ARC with those hotel shares on every line.
 */
async function makeContract(t, {
  hotelId = A1, departmentId = FB, vendorId = VENDOR, lines, status = "active", committedQty = 1000, consumedQty = 0,
  group = null,
}) {
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'Reorder ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${tag()}`.slice(0, 40), CO, hotelId, departmentId, IDS.processes.A_P1, STORE_ID]
  );
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, $3) RETURNING id`,
    [arc.id, vendorId, status]
  );
  const lineIds = [];
  for (const l of lines) {
    const item = await t.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 100, $3) RETURNING id`,
      [arc.id, l.variantId, l.uom ?? "litre"]
    );
    const line = await t.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, consumed_qty)
       VALUES ($1, $2, $3, 5, $4, $5) RETURNING id`,
      [contract.id, item.id, l.unitRate ?? 90, committedQty, consumedQty]
    );
    lineIds.push(Number(line.id));
    for (const [shareHotel, share] of Object.entries(group ?? {})) {
      await t.none(
        `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, consumed_qty, unit_rate_override)
         VALUES ($1, $2, $3, $4, $5)`,
        [line.id, Number(shareHotel), share.committedQty, share.consumedQty ?? 0, share.rateOverride ?? null]
      );
    }
  }
  if (group) await t.none(`UPDATE tbl_arc SET is_group = true WHERE id = $1`, [arc.id]);
  return { arcId: Number(arc.id), contractId: Number(contract.id), lineIds };
}

/** An MR at the hotel in `status` with items [{variantId, qty, uom, contractId, lineId}]. */
async function makeMr(t, { hotelId = A1, departmentId = FB, status, items }) {
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status)
     VALUES ($1, 'Reorder test MR', $2, $3, $4, 'normal', $5, $6) RETURNING id`,
    [`MR-${tag()}`.slice(0, 40), CO, hotelId, departmentId, STORE_ID, status]
  );
  for (const it of items) {
    await t.none(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1, $2, $3, $4, $5, $6, 90)`,
      [mr.id, it.variantId, it.qty, it.uom ?? null, it.contractId, it.lineId]
    );
  }
  return Number(mr.id);
}

async function startStock(t, hotelId) {
  await t.none(
    `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, stock_started_at) VALUES ($1, $2, now())
     ON CONFLICT (hotel_id) DO UPDATE SET stock_started_at = now()`,
    [hotelId, CO]
  );
}

const rowOf = (list, invItemId) => list.rows.find((r) => r.invItemId === invItemId);

describe("reorder worklist", () => {
  it("suggested qty = max - on hand - on order", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const [v1, v2, v3, v4, v5] = V;
      // Milk: 4 on hand, 12 still to come on a plan row here, 5 on an approved MR
      const milk = await itemWith(t, { name: "Milk", variantId: v1, reorderLevel: 10, maxQty: 50, qty: 4 });
      const po = await makeRfqPo(t, { lines: [{ qty: 20, unit: "litre", variantId: v1 }] });
      const [, phase2] = await setPlan(t, po.poId, [
        { hotelId: A1, phaseNo: 1, dueDate: DAY, lines: { [po.lineIds[0]]: 12 } },
        { hotelId: A1, phaseNo: 2, dueDate: DAY, lines: { [po.lineIds[0]]: 8 } },
      ]);
      // phase 2 has arrived in full: nothing more to come there
      await t.none(`UPDATE tbl_po_delivery_line SET accepted_qty = 8 WHERE id = $1`, [phase2.lines[po.lineIds[0]]]);
      const arc = await makeContract(t, { lines: [{ variantId: v1, uom: "litre" }] });
      const mrItem = { variantId: v1, qty: 5, uom: "litre", contractId: arc.contractId, lineId: arc.lineIds[0] };
      await makeMr(t, { status: "approved", items: [mrItem] });
      // drafts, pending ones and released ones are not on order (a released MR is its call-off PO)
      await makeMr(t, { status: "draft", items: [mrItem] });
      await makeMr(t, { status: "pending_approval", items: [mrItem] });
      await makeMr(t, { status: "po_released", items: [mrItem] });

      // Eggs: rounded up to the smallest pack above 1 (a tray of 30; the case is 360)
      const eggs = await itemWith(t, { name: "Eggs", stockUom: "pcs", variantId: v2, reorderLevel: 30, maxQty: 95, qty: 10 });
      await addBarcode(t, eggs, 1);
      await addBarcode(t, eggs, 30);
      await addBarcode(t, eggs, 360);

      // Flour: no pack, rounded up to 0.01
      const flour = await itemWith(t, { name: "Flour", stockUom: "kg", reorderLevel: 5, maxQty: 12.5 });
      await stockIn(t, { invItemId: flour, qty: 2.333, unitCost: 40 });

      // Rice: 2 bags of 25 kg on order; a line in boxes has no factor and is left out
      const rice = await itemWith(t, { name: "Rice", stockUom: "kg", variantId: v3, reorderLevel: 20, maxQty: 80 });
      await setUom(t, rice, "Bag", 25);
      const ricePo = await makeRfqPo(t, { lines: [{ qty: 2, unit: " BAG ", variantId: v3 }, { qty: 4, unit: "box", variantId: v3 }] });
      await setPlan(t, ricePo.poId, [{ hotelId: A1, lines: { [ricePo.lineIds[0]]: 2, [ricePo.lineIds[1]]: 4 } }]);

      // Salt: no max level, so no suggestion
      const salt = await itemWith(t, { name: "Salt", stockUom: "kg", variantId: v4, reorderLevel: 3 });

      // Not on the list: above its level, no level at all, inactive
      const sugar = await itemWith(t, { name: "Sugar", stockUom: "kg", variantId: v5, reorderLevel: 10, maxQty: 30, qty: 11 });
      const tea = await itemWith(t, { name: "Tea", stockUom: "kg", qty: 1 });
      const old = await itemWith(t, { name: "Old stock", stockUom: "kg", reorderLevel: 10, maxQty: 30 });
      await t.none(`UPDATE tbl_inv_item SET is_active = false WHERE id = $1`, [old]);

      const list = await getReorderList(t, STORE, { hotelId: A1 });
      expect(list.hotelId).toBe(A1);
      expect(list.rows.map((r) => r.displayName)).toEqual(["Eggs", "Flour", "Milk", "Rice", "Salt"]);
      expect(list.rows.map((r) => r.invItemId)).not.toEqual(expect.arrayContaining([sugar, tea, old]));

      expect(rowOf(list, milk)).toMatchObject({
        qty: 4, reorderLevel: 10, maxQty: 50, onOrder: 17, onOrderIncomplete: false, suggestedQty: 29, stockUom: "litre",
      });
      expect(rowOf(list, eggs)).toMatchObject({ qty: 10, onOrder: 0, packFactor: 30, suggestedQty: 90 });
      expect(rowOf(list, flour)).toMatchObject({ qty: 2.333, onOrder: 0, suggestedQty: 10.17, productVariantId: null });
      expect(rowOf(list, rice)).toMatchObject({ qty: 0, onOrder: 50, onOrderIncomplete: true, suggestedQty: 30 });
      expect(rowOf(list, salt)).toMatchObject({ maxQty: null, suggestedQty: null });

      // on order covering the gap suggests nothing
      await makeMr(t, { status: "approved", items: [{ ...mrItem, qty: 100 }] });
      expect(rowOf(await getReorderList(t, STORE, { hotelId: A1 }), milk)).toMatchObject({ onOrder: 117, suggestedQty: 0 });
    });
  });

  it("on order counts this hotel's open plan rows, not unallocated", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const v = V[1];
      const soap = await itemWith(t, { name: "Soap", stockUom: "pcs", variantId: v, reorderLevel: 10, maxQty: 40 });
      await setLevels(t, { hotelId: A2, invItemId: soap, reorderLevel: 10, maxQty: 40 });

      // a multi-hotel PO split by hotel, with part of it still unallocated
      const multi = await makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 30, unit: "pcs", variantId: v }] });
      const line = multi.lineIds[0];
      const [atA1] = await setPlan(t, multi.poId, [
        { hotelId: A1, lines: { [line]: 8 } },
        { hotelId: A2, lines: { [line]: 6 } },
        { hotelId: null, lines: { [line]: 7 } },
      ]);
      // 3 of A1's 8 have arrived
      await t.none(`UPDATE tbl_po_delivery_line SET accepted_qty = 3 WHERE id = $1`, [atA1.lines[line]]);

      // not on order: a legacy PO, a cancelled PO, a short-closed row
      const legacy = await makeRfqPo(t, { lines: [{ qty: 9, unit: "pcs", variantId: v }] });
      await setPlan(t, legacy.poId, [{ hotelId: A1, lines: { [legacy.lineIds[0]]: 9 } }]);
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [legacy.poId]);
      const cancelled = await makeRfqPo(t, { status: "cancelled", lines: [{ qty: 4, unit: "pcs", variantId: v }] });
      await setPlan(t, cancelled.poId, [{ hotelId: A1, lines: { [cancelled.lineIds[0]]: 4 } }]);
      const closed = await makeRfqPo(t, { lines: [{ qty: 10, unit: "pcs", variantId: v }] });
      const [closedRow] = await setPlan(t, closed.poId, [{ hotelId: A1, lines: { [closed.lineIds[0]]: 10 } }]);
      await t.none(`UPDATE tbl_po_delivery_line SET short_closed_qty = 10 WHERE id = $1`, [closedRow.lines[closed.lineIds[0]]]);

      // POs not planned yet: a single-hotel one counts at its hotel, a multi-hotel one is only a hint
      await makeRfqPo(t, { lines: [{ qty: 3, unit: "pcs", variantId: v }] });
      await makeRfqPo(t, { mappedHotels: [A1, A2], lines: [{ qty: 4, unit: "pcs", variantId: v }] });

      const a1 = await getReorderList(t, STORE, { hotelId: A1 });
      expect(rowOf(a1, soap)).toMatchObject({ onOrder: 5 + 3, suggestedQty: 40 - 8 });
      expect(a1.groupOrdersOpen).toEqual([{ invItemId: soap, openQty: 7 + 4 }]);

      const a2 = await getReorderList(t, CTRL, { hotelId: A2 });
      expect(rowOf(a2, soap)).toMatchObject({ onOrder: 6, suggestedQty: 34 });
      expect(a2.groupOrdersOpen).toEqual([{ invItemId: soap, openQty: 11 }]);
    });
  });

  it("contracted lines: the cheapest per department the caller may raise an MR for", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t);
      const v = V[0];
      const milk = await itemWith(t, { name: "Milk", variantId: v, reorderLevel: 10, maxQty: 50 });
      const fb90 = await makeContract(t, { departmentId: FB, lines: [{ variantId: v, unitRate: 90 }] });
      const fb80 = await makeContract(t, { departmentId: FB, vendorId: VENDOR_B, lines: [{ variantId: v, unitRate: 80 }] });
      const hk70 = await makeContract(t, { departmentId: HK, lines: [{ variantId: v, unitRate: 70 }] });
      // not counted: a contract at another hotel, a terminated contract
      await makeContract(t, { hotelId: A2, departmentId: FB, lines: [{ variantId: v, unitRate: 10 }] });
      await makeContract(t, { departmentId: FB, lines: [{ variantId: v, unitRate: 5 }], status: "terminated" });

      const list = await getReorderList(t, STORE, { hotelId: A1 });
      const row = rowOf(list, milk);
      expect(row.contracted).toMatchObject({
        departmentId: HK, arcContractId: hk70.contractId, arcContractLineId: hk70.lineIds[0], unitRate: 70, uom: "litre",
      });
      expect(row.contractedLines.map((l) => [l.departmentId, l.arcContractLineId, l.unitRate])).toEqual([
        [HK, hk70.lineIds[0], 70],
        [FB, fb80.lineIds[0], 80],
      ]);
      expect(row.productVariantId).toBe(v);
      expect(row.contractedLines.map((l) => l.arcContractLineId)).not.toContain(fb90.lineIds[0]);

      // a buyer who may raise MRs only for Engineering at A1 sees no F&B or Housekeeping rates
      const eng = IDS.users.a1_eng_buyer;
      await grantRoleScope(t, { userId: eng, roleId: await roleId(t, "Storekeeper"), companyId: CO, hotelId: A1, departmentId: ENG });
      await grantMr(t, eng, { departmentId: ENG });
      const engList = await getReorderList(t, { id: eng, user_type: 2 }, { hotelId: A1 });
      expect(engList.departments.map((d) => d.id)).toEqual([ENG]);
      expect(rowOf(engList, milk)).toMatchObject({ contracted: null, contractedLines: [], productVariantId: v });

      // nor does one who may raise none (inventory.update is not mr.create)
      const ctrlList = await getReorderList(t, CTRL, { hotelId: A1 });
      expect(ctrlList.departments).toEqual([]);
      expect(rowOf(ctrlList, milk)).toMatchObject({ contracted: null, contractedLines: [] });
    });
  });

  it("a line shows the rate the MR will store, and the cheapest is picked on that rate", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t);
      const v = V[0];
      const milk = await itemWith(t, { name: "Milk", variantId: v, reorderLevel: 10, maxQty: 50 });
      // F&B: a group line at 90 with this hotel's override at 60, a plain line at 80
      await makeContract(t, {
        departmentId: FB, lines: [{ variantId: v, unitRate: 90 }], committedQty: 500, consumedQty: 100,
        group: { [A1]: { committedQty: 40, consumedQty: 10, rateOverride: 60 } },
      });
      const plain = await makeContract(t, { departmentId: FB, vendorId: VENDOR_B, lines: [{ variantId: v, unitRate: 80 }] });
      // Housekeeping: only a group line at 90, overridden to 50 here
      const hkGroup = await makeContract(t, {
        departmentId: HK, lines: [{ variantId: v, unitRate: 90 }], committedQty: 500, consumedQty: 100,
        group: { [A1]: { committedQty: 40, consumedQty: 10, rateOverride: 50 } },
      });

      const row = rowOf(await getReorderList(t, STORE, { hotelId: A1 }), milk);
      expect(row.contracted).toMatchObject({
        departmentId: FB, arcContractLineId: plain.lineIds[0], unitRate: 80, remainingQty: 1000, isGroup: false,
        hotelRemainingQty: null,
      });
      const hk = row.contractedLines.find((l) => l.departmentId === HK);
      expect(hk).toMatchObject({
        arcContractLineId: hkGroup.lineIds[0], unitRate: 90, remainingQty: 400, isGroup: true, hotelRemainingQty: 30,
      });

      // the draft stores exactly the rate the list showed
      const draft = await createReorderMrDraft(t, STORE, { hotelId: A1, departmentId: HK, items: [{ invItemId: milk, qty: 5 }] });
      const stored = await t.one(
        `SELECT matched_unit_rate::float AS rate FROM tbl_material_requisition_item WHERE mr_id = $1`,
        [draft.mrId]
      );
      expect(stored.rate).toBe(hk.unitRate);
      expect(draft.items[0].unitRate).toBe(hk.unitRate);
    });
  });

  it("open MR quantity: drafts and pending MRs at the hotel, shown and never subtracted", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const v = V[0];
      const milk = await itemWith(t, { name: "Milk", variantId: v, reorderLevel: 10, maxQty: 50, qty: 4 });
      await setUom(t, milk, "case", 12);
      const arc = await makeContract(t, { lines: [{ variantId: v, uom: "litre" }] });
      const it = (qty, uom = "litre") => ({ variantId: v, qty, uom, contractId: arc.contractId, lineId: arc.lineIds[0] });
      await makeMr(t, { status: "draft", items: [it(5)] });
      await makeMr(t, { status: "pending_approval", items: [it(3)] });
      await makeMr(t, { status: "draft", items: [it(2, "case")] }); // 24 litres
      await makeMr(t, { status: "approved", items: [it(7)] }); // on order
      await makeMr(t, { status: "cancelled", items: [it(100)] });
      await makeMr(t, { status: "rejected", items: [it(50)] });
      await makeMr(t, { hotelId: A2, status: "draft", items: [it(9)] }); // another hotel

      const row = rowOf(await getReorderList(t, STORE, { hotelId: A1 }), milk);
      expect(row).toMatchObject({ qty: 4, onOrder: 7, openMrQty: 5 + 3 + 24, suggestedQty: 50 - 4 - 7 });
    });
  });

  it("can.createMrDraft: a buyer holding mr.create at the hotel, in any department", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await itemWith(t, { name: "Milk", variantId: V[0], reorderLevel: 10, maxQty: 50 });
      const at = async (user) => {
        const list = await getReorderList(t, user, { hotelId: A1 });
        return { can: list.can, departments: list.departments.map((d) => d.id) };
      };
      // Storekeeper only, Inventory Controller only: inventory.update is not mr.create
      expect(await at(STORE)).toEqual({ can: { createMrDraft: false }, departments: [] });
      expect(await at(CTRL)).toEqual({ can: { createMrDraft: false }, departments: [] });
      // mr.create bound to a process does not count: an MR has no process
      await grantMr(t, STORE_ID, { departmentId: FB, processId: IDS.processes.A_P1 });
      // nor does mr.create at another hotel
      await grantMr(t, STORE_ID, { hotelId: A2, departmentId: FB });
      expect(await at(STORE)).toEqual({ can: { createMrDraft: false }, departments: [] });

      // mr.create at A1 for F&B: that department, and the flag
      await grantMr(t, STORE_ID, { departmentId: FB });
      expect(await at(STORE)).toEqual({ can: { createMrDraft: true }, departments: [FB] });
      // every department it lists is one the draft's own check admits
      await expect(
        assertUserHasScope(STORE_ID, "mr.create", { hospitality_company_id: CO, hotel_id: A1, department_id: FB }, t)
      ).resolves.toBeUndefined();
      await expect(
        assertUserHasScope(STORE_ID, "mr.create", { hospitality_company_id: CO, hotel_id: A1, department_id: HK }, t)
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      // the same grant on a non-buyer account
      expect(await at({ id: STORE_ID, user_type: 5 })).toEqual({ can: { createMrDraft: false }, departments: [] });

      // mr.create for every department of the hotel
      await grantMr(t, CTRL_ID);
      const all = await at(CTRL);
      expect(all.can).toEqual({ createMrDraft: true });
      expect(all.departments).toEqual(expect.arrayContaining([FB, HK, ENG]));

      // inventory.read only
      const viewer = IDS.users.a1_proc_techEval;
      const custom = Number((await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ('D3 list viewer', 'reorder test', $1) RETURNING id`,
        [STORE_ID]
      )).id);
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'inventory' AND action::text = 'read'`,
        [custom]
      );
      await grantRoleScope(t, { userId: viewer, roleId: custom, companyId: CO });
      const seen = await getReorderList(t, { id: viewer, user_type: 2 }, { hotelId: A1 });
      expect(seen.hotelId).toBe(A1);
      expect(seen.can).toEqual({ createMrDraft: false });
      // no hotel at all
      expect((await getReorderList(t, { id: VENDOR, user_type: 3 }, {})).can).toEqual({ createMrDraft: false });
    });
  });

  it("a hotel outside the caller's scope is not found", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const err = await thrownBy(t, (sp) => getReorderList(sp, FOREIGN, { hotelId: A1 }));
      expect(err.code).toBe("NOT_FOUND");
      // with no hotelId the caller's own first hotel is used
      const own = await getReorderList(t, STORE, {});
      expect(own.hotelId).toBe(own.hotels[0].id);
      expect(own.hotels.map((h) => h.id)).toEqual(expect.arrayContaining([A1, A2]));
    });
  });
});

describe("MR draft from the reorder list", () => {
  it("contracted items create an MR draft with ARC line", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t, STORE_ID, { departmentId: FB });
      const [v1, , v3] = V;
      const milk = await itemWith(t, { name: "Milk", variantId: v1, reorderLevel: 10, maxQty: 50, qty: 4 });
      const juice = await itemWith(t, { name: "Juice", variantId: v3, reorderLevel: 12, maxQty: 36 });
      await setUom(t, juice, "case", 12);
      const fb90 = await makeContract(t, { departmentId: FB, lines: [{ variantId: v1, unitRate: 90 }] });
      const fb80 = await makeContract(t, {
        departmentId: FB, vendorId: VENDOR_B, lines: [{ variantId: v1, unitRate: 80 }, { variantId: v3, unitRate: 300, uom: "Case" }],
      });
      await makeContract(t, { departmentId: HK, lines: [{ variantId: v1, unitRate: 70 }] });

      const draft = await createReorderMrDraft(t, STORE, {
        hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 29 }, { invItemId: juice, qty: 30 }],
      });
      expect(draft).toMatchObject({ mrId: expect.any(Number), mrNumber: expect.stringMatching(/^MR-\d{4}-/), hotelId: A1, departmentId: FB });

      const mr = await t.one(`SELECT * FROM tbl_material_requisition WHERE id = $1`, [draft.mrId]);
      expect(mr).toMatchObject({
        status: "draft", hospitality_company_id: CO, hotel_id: A1, department_id: FB, raised_by: STORE_ID,
      });
      expect(mr.title).toMatch(/^Reorder: /);
      const items = await t.any(
        `SELECT product_variant_id, quantity::float AS quantity, uom, arc_contract_id::int AS arc_contract_id,
                arc_contract_line_id::int AS arc_contract_line_id, matched_unit_rate::float AS rate
           FROM tbl_material_requisition_item WHERE mr_id = $1 ORDER BY id`,
        [draft.mrId]
      );
      expect(items).toEqual([
        // the cheapest F&B line (the Housekeeping one is cheaper, but this MR is F&B's)
        { product_variant_id: v1, quantity: 29, uom: "litre", arc_contract_id: fb80.contractId, arc_contract_line_id: fb80.lineIds[0], rate: 80 },
        // 30 litres in the contract's unit: 2.5 cases of 12
        { product_variant_id: v3, quantity: 2.5, uom: "Case", arc_contract_id: fb80.contractId, arc_contract_line_id: fb80.lineIds[1], rate: 300 },
      ]);

      // the caller may pick another eligible line
      const chosen = await createReorderMrDraft(t, STORE, {
        hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 5, arcContractLineId: fb90.lineIds[0] }],
      });
      expect(chosen.items).toEqual([expect.objectContaining({ arcContractLineId: fb90.lineIds[0], quantity: 5, unitRate: 90 })]);

      // the draft MR's lines are not on order yet (only approved MRs are)
      expect(rowOf(await getReorderList(t, STORE, { hotelId: A1 }), milk).onOrder).toBe(0);
    });
  });

  it("non-contracted item rejected from MR path", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t, STORE_ID, { departmentId: FB });
      const [v1, v2, v3, v4] = V;
      const milk = await itemWith(t, { name: "Milk", variantId: v1, reorderLevel: 10, maxQty: 50 });
      const soap = await itemWith(t, { name: "Soap", stockUom: "pcs", variantId: v2, reorderLevel: 10, maxQty: 40 });
      const loose = await itemWith(t, { name: "Loose item", stockUom: "pcs", reorderLevel: 1, maxQty: 5 });
      const hkOnly = await itemWith(t, { name: "Bleach", variantId: v3, reorderLevel: 1, maxQty: 5 });
      const oil = await itemWith(t, { name: "Oil", variantId: v4, reorderLevel: 1, maxQty: 5 });
      const fb = await makeContract(t, { departmentId: FB, lines: [{ variantId: v1 }, { variantId: v4, uom: "tin" }] });
      const hk = await makeContract(t, { departmentId: HK, lines: [{ variantId: v3 }] });
      const mrCount = async () => Number((await t.one(`SELECT count(*) FROM tbl_material_requisition WHERE raised_by = $1`, [STORE_ID])).count);
      const before = await mrCount();

      const err = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, {
          hotelId: A1, departmentId: FB,
          items: [{ invItemId: milk, qty: 5 }, { invItemId: soap, qty: 30 }, { invItemId: loose, qty: 1 }, { invItemId: hkOnly, qty: 2 }],
        })
      );
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toMatchObject({ field: "items", index: 1, invItemId: soap, reason: "NOT_CONTRACTED" });
      expect(err.details.lines.map((l) => [l.invItemId, l.reason])).toEqual([
        [soap, "NOT_CONTRACTED"], [loose, "NOT_CONTRACTED"], [hkOnly, "NOT_CONTRACTED"],
      ]);
      expect(await mrCount()).toBe(before);

      // a line of another department cannot be named either
      const named = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, { hotelId: A1, departmentId: FB, items: [{ invItemId: hkOnly, qty: 1, arcContractLineId: hk.lineIds[0] }] })
      );
      expect(named.details).toMatchObject({ invItemId: hkOnly, reason: "NOT_CONTRACTED" });
      const wrongLine = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, { hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 1, arcContractLineId: fb.lineIds[1] }] })
      );
      expect(wrongLine.details).toMatchObject({ invItemId: milk, reason: "NOT_CONTRACTED" });

      // a contract unit with no conversion to the stock unit is refused, never taken at 1
      const unit = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, { hotelId: A1, departmentId: FB, items: [{ invItemId: oil, qty: 3 }] })
      );
      expect(unit.code).toBe("VALIDATION");
      expect(unit.details).toMatchObject({ invItemId: oil, reason: "UOM_FACTOR_REQUIRED" });
      expect(unit.message).toMatch(/litre.*tin.*Oil/);
      expect(await mrCount()).toBe(before);
    });
  });

  it("a contract's remaining quantity is a hard cap; a group hotel's own share is soft", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t);
      const [v1, , v3] = V;
      const milk = await itemWith(t, { name: "Milk", variantId: v1, reorderLevel: 10, maxQty: 50 });
      const juice = await itemWith(t, { name: "Juice", variantId: v3, reorderLevel: 12, maxQty: 36 });
      await setUom(t, juice, "case", 12);
      // 5 left on each line (litres for milk, cases for juice)
      const tight = await makeContract(t, {
        departmentId: FB, lines: [{ variantId: v1, unitRate: 80 }, { variantId: v3, unitRate: 300, uom: "Case" }],
        committedQty: 10, consumedQty: 5,
      });
      const mrCount = async () => Number((await t.one(`SELECT count(*) FROM tbl_material_requisition WHERE raised_by = $1`, [STORE_ID])).count);
      const before = await mrCount();

      // 6 litres of milk; 72 litres of juice = 6 cases
      const err = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, {
          hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 6 }, { invItemId: juice, qty: 72 }],
        })
      );
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toMatchObject({
        field: "items", index: 0, invItemId: milk, reason: "EXCEEDS_CONTRACT_REMAINING", remaining: 5, quantity: 6,
      });
      expect(err.details.lines.map((l) => [l.invItemId, l.reason, l.quantity, l.remaining, l.uom, l.arcContractLineId])).toEqual([
        [milk, "EXCEEDS_CONTRACT_REMAINING", 6, 5, "litre", tight.lineIds[0]],
        [juice, "EXCEEDS_CONTRACT_REMAINING", 6, 5, "Case", tight.lineIds[1]],
      ]);
      expect(err.message).toBe("2 items cannot go on a requisition: Milk: 6 litre is more than the contract has left (5 litre)");
      expect(await mrCount()).toBe(before);

      // exactly what is left goes through
      const exact = await createReorderMrDraft(t, STORE, {
        hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 5 }, { invItemId: juice, qty: 60 }],
      });
      expect(exact.items.map((i) => i.quantity)).toEqual([5, 5]);
      expect(exact.warnings).toEqual([]);

      // a group line: 100 left for the group, 2 left of this hotel's share
      const group = await makeContract(t, {
        departmentId: HK, lines: [{ variantId: v1, unitRate: 90 }], committedQty: 100, consumedQty: 0,
        group: { [A1]: { committedQty: 10, consumedQty: 8 } },
      });
      const over = await createReorderMrDraft(t, STORE, { hotelId: A1, departmentId: HK, items: [{ invItemId: milk, qty: 5 }] });
      expect(over.items).toEqual([expect.objectContaining({ arcContractLineId: group.lineIds[0], quantity: 5 })]);
      expect(over.warnings).toEqual([
        {
          invItemId: milk, arcContractLineId: group.lineIds[0], hotelId: A1, quantity: 5, hotelRemainingQty: 2,
          message: "Milk: 5 is more than this hotel's remaining share (2). The group total has room, so the order can go ahead; head office will be told.",
        },
      ]);
      // past the group's own remaining: refused
      const groupOver = await thrownBy(t, (sp) =>
        createReorderMrDraft(sp, STORE, { hotelId: A1, departmentId: HK, items: [{ invItemId: milk, qty: 101 }] })
      );
      expect(groupOver.details).toMatchObject({ reason: "EXCEEDS_CONTRACT_REMAINING", remaining: 100, quantity: 101 });
    });
  });

  it("a repeated clientEventId answers the draft it made, and never another one", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      await grantMr(t);
      await grantMr(t, CTRL_ID);
      const milk = await itemWith(t, { name: "Milk", variantId: V[0], reorderLevel: 10, maxQty: 50 });
      await makeContract(t, { departmentId: FB, lines: [{ variantId: V[0], unitRate: 80 }] });
      await makeContract(t, { departmentId: HK, lines: [{ variantId: V[0], unitRate: 80 }] });
      const key = randomUUID();
      const body = { hotelId: A1, departmentId: FB, clientEventId: key, items: [{ invItemId: milk, qty: 5 }] };

      const first = await createReorderMrDraft(t, STORE, body);
      expect(first).not.toHaveProperty("replayed");
      expect(first).toMatchObject({ status: "draft", items: [{ invItemId: milk, quantity: 5, unitRate: 80 }] });
      // a retry (even with other quantities, or the key in capitals) answers the first draft
      const again = await createReorderMrDraft(t, STORE, { ...body, clientEventId: key.toUpperCase(), items: [{ invItemId: milk, qty: 9 }] });
      expect(again).toEqual({ ...first, replayed: true, no_op: true });
      const made = await t.any(`SELECT id FROM tbl_material_requisition WHERE client_event_id = $1`, [key]);
      expect(made.map((r) => Number(r.id))).toEqual([first.mrId]);

      // the key never answers another department's or another user's request
      const otherDept = await thrownBy(t, (sp) => createReorderMrDraft(sp, STORE, { ...body, departmentId: HK }));
      expect(otherDept).toMatchObject({ code: "CONFLICT", details: { field: "clientEventId" } });
      const otherUser = await thrownBy(t, (sp) => createReorderMrDraft(sp, CTRL, body));
      expect(otherUser).toMatchObject({ code: "CONFLICT", details: { field: "clientEventId" } });
      const bad = await thrownBy(t, (sp) => createReorderMrDraft(sp, STORE, { ...body, clientEventId: "not-a-uuid" }));
      expect(bad).toMatchObject({ code: "VALIDATION", details: { field: "clientEventId" } });
      // no key: a new draft each time
      const plain = await createReorderMrDraft(t, STORE, { ...body, clientEventId: undefined });
      expect(plain.mrId).not.toBe(first.mrId);
    });
  });

  it("the hotel comes from the caller's scope; the department needs mr.create there", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const milk = await itemWith(t, { name: "Milk", variantId: V[0], reorderLevel: 10, maxQty: 50 });
      await makeContract(t, { departmentId: FB, lines: [{ variantId: V[0] }] });
      const body = { hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 5 }] };
      const refusal = async (user, input = body) => {
        const err = await thrownBy(t, (sp) => createReorderMrDraft(sp, user, input));
        return { code: err.code, details: err.details };
      };
      const answer = async (user, input) => {
        const err = await thrownBy(t, (sp) => createReorderMrDraft(sp, user, input));
        return { code: err.code, message: err.message, details: err.details };
      };
      const noMrCreate = {
        code: "FORBIDDEN", details: { resource: "mr", action: "create", hotelId: A1, departmentId: FB },
      };

      // another company's hotel
      expect((await refusal(FOREIGN)).code).toBe("NOT_FOUND");

      // Storekeeper only, Inventory Controller only: they see the hotel, and
      // inventory.update does not raise an MR
      expect(await refusal(STORE)).toEqual(noMrCreate);
      expect(await refusal(CTRL)).toEqual(noMrCreate);

      // inventory.read only: the same
      const viewer = IDS.users.a1_proc_techEval;
      const custom = Number((await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ('D3 inventory viewer', 'reorder test', $1) RETURNING id`,
        [STORE_ID]
      )).id);
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'inventory' AND action::text = 'read'`,
        [custom]
      );
      await grantRoleScope(t, { userId: viewer, roleId: custom, companyId: CO });
      expect(await refusal({ id: viewer, user_type: 2 })).toEqual(noMrCreate);

      // mr.create at A1 for Engineering cannot raise an F&B requisition
      const eng = IDS.users.a1_eng_buyer;
      await grantRoleScope(t, { userId: eng, roleId: await roleId(t, "Storekeeper"), companyId: CO, hotelId: A1, departmentId: ENG });
      await grantMr(t, eng, { departmentId: ENG });
      const engUser = { id: eng, user_type: 2 };
      expect(await refusal(engUser)).toEqual(noMrCreate);
      // Engineering itself is in scope (milk just has no Engineering contract)
      expect((await refusal(engUser, { ...body, departmentId: ENG })).details).toMatchObject({ reason: "NOT_CONTRACTED" });

      // mr.create bound to a process does not count (an MR has no process)
      await grantMr(t, STORE_ID, { departmentId: FB, processId: IDS.processes.A_P1 });
      expect(await refusal(STORE)).toEqual(noMrCreate);

      // mr.create with no inventory.read at the hotel: the hotel is not
      // visible, and reads exactly as a hotel that does not exist
      const raiserOnly = { id: IDS.users.a1_proc_commEval, user_type: 2 };
      await grantMr(t, raiserOnly.id, { departmentId: FB });
      const hidden = await answer(raiserOnly, body);
      expect(hidden.code).toBe("NOT_FOUND");
      expect(hidden).toEqual(await answer(raiserOnly, { ...body, hotelId: 2000000000 }));

      // mr.create at A1 for F&B: the draft is made
      await grantMr(t, STORE_ID, { departmentId: FB });
      const made = await createReorderMrDraft(t, STORE, body);
      expect(made).toMatchObject({ hotelId: A1, departmentId: FB, items: [{ invItemId: milk, quantity: 5 }] });
      // and only for F&B
      expect(await refusal(STORE, { ...body, departmentId: HK })).toEqual({
        ...noMrCreate, details: { ...noMrCreate.details, departmentId: HK },
      });

      // an unknown department is not found
      const ghost = await refusal(STORE, { ...body, departmentId: 999999 });
      expect(ghost).toEqual({ code: "NOT_FOUND", details: { field: "departmentId" } });

      // a foreign item id is not found
      const other = await makeItem(t, { companyId: IDS.hospitality.B, name: "Company B item" });
      expect((await refusal(STORE, { ...body, items: [{ invItemId: other, qty: 1 }] })).code).toBe("NOT_FOUND");
    });
  });
});

describe("who may raise the draft: the list and the draft agree", () => {
  it("for every shape of mr.create grant, GET lists exactly the departments the POST admits", async () => {
    await withTx(async (t) => {
      const buyer = IDS.users.a1_eng_buyer;
      const user = { id: buyer, user_type: 2 };
      await grantRoleScope(t, { userId: buyer, roleId: await roleId(t, "Storekeeper"), companyId: CO });
      const milk = await itemWith(t, { name: "Milk", variantId: V[0], reorderLevel: 10, maxQty: 50 });
      await makeContract(t, { departmentId: FB, lines: [{ variantId: V[0] }] });
      const all = (await t.any(`SELECT id FROM tbl_department ORDER BY id`)).map((r) => Number(r.id));
      const raiser = await roleId(t, "MR Raiser");

      const shapes = [
        ["company-wide", { hotelId: null, departmentId: null }, all],
        ["at this hotel", { hotelId: A1, departmentId: null }, all],
        ["at another hotel", { hotelId: A2, departmentId: null }, []],
        ["one department here", { hotelId: A1, departmentId: FB }, [FB]],
        ["one department, company-wide", { hotelId: null, departmentId: HK }, [HK]],
        ["bound to a process", { hotelId: A1, departmentId: null, processId: IDS.processes.A_P1 }, []],
      ];
      for (const [shape, grant, expected] of shapes) {
        const scope = await grantRoleScope(t, { userId: buyer, roleId: raiser, companyId: CO, ...grant });
        const list = await getReorderList(t, user, { hotelId: A1 });
        const listed = list.departments.map((d) => d.id).sort((a, b) => a - b);
        // the draft's own check, department by department
        const admitted = [];
        for (const d of all) {
          const ok = await assertUserHasScope(buyer, "mr.create", { hospitality_company_id: CO, hotel_id: A1, department_id: d }, t)
            .then(() => true, () => false);
          if (ok) admitted.push(d);
        }
        const draft = await thrownBy(t, (sp) =>
          createReorderMrDraft(sp, user, { hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 1 }] }).then(() => {
            throw Object.assign(new Error("made"), { code: "MADE" });
          })
        );
        expect({ shape, listed, can: list.can.createMrDraft, fb: draft.code }).toEqual({
          shape, listed: admitted, can: admitted.length > 0, fb: admitted.includes(FB) ? "MADE" : "FORBIDDEN",
        });
        expect({ shape, listed }).toEqual({ shape, listed: [...expected].sort((a, b) => a - b) });
        await revokeRoleScopes(t, [scope]);
      }
    });
  });
});

describe("low-stock digest", () => {
  it("low-stock digest skips not-started hotels", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const milk = await itemWith(t, { name: "Milk", reorderLevel: 10, maxQty: 50, qty: 4 });
      await itemWith(t, { name: "Sugar", stockUom: "kg", reorderLevel: 10, maxQty: 30, qty: 11 }); // above its level
      const eggs = await itemWith(t, { name: "Eggs", stockUom: "pcs", reorderLevel: 30, maxQty: 90 }); // none on hand
      const old = await itemWith(t, { name: "Old", reorderLevel: 10 });
      await t.none(`UPDATE tbl_inv_item SET is_active = false WHERE id = $1`, [old]);
      // A2 is below too, but its stock has not started
      await setLevels(t, { hotelId: A2, invItemId: milk, reorderLevel: 10, maxQty: 50 });
      await startStock(t, A1);

      const notify = jest.fn(async () => ({ sent: true, recipients: 2 }));
      const out = await runLowStockSweep({ conn: t, today: DAY, notify });
      expect(out).toMatchObject({ date: DAY, hotels: 1, digests: 1 });
      expect(notify).toHaveBeenCalledTimes(1);
      const [digest] = notify.mock.calls[0];
      expect(digest).toMatchObject({ hotelId: A1, companyId: CO, date: DAY, hotelName: expect.any(String) });
      expect(digest.items).toEqual([
        { invItemId: eggs, displayName: "Eggs", stockUom: "pcs", qty: 0, reorderLevel: 30 },
        { invItemId: milk, displayName: "Milk", stockUom: "litre", qty: 4, reorderLevel: 10 },
      ]);

      // once A2 starts, it is digested too
      await startStock(t, A2);
      notify.mockClear();
      await runLowStockSweep({ conn: t, today: DAY, notify });
      expect(notify.mock.calls.map(([d]) => d.hotelId).sort()).toEqual([A1, A2].sort());
    });
  });

  it("the digest reaches inventory.update holders at that hotel, once per day", async () => {
    const digestRows = () =>
      db.any(
        `SELECT recipient_user_id, action_url, title, message FROM tbl_notifications
          WHERE type = 'inventory_low_stock_digest' AND additional_data->>'date' = $1`,
        [DAY]
      );
    try {
      await withTx(async (t) => {
        await grantCast(t);
        await itemWith(t, { name: "Milk", reorderLevel: 10, maxQty: 50, qty: 4 });
        await startStock(t, A1);

        const out = await runLowStockSweep({ conn: t, today: DAY });
        expect(out.digests).toBe(1);
        const rows = await digestRows();
        const recipients = rows.map((r) => Number(r.recipient_user_id));
        expect(recipients).toEqual(expect.arrayContaining([STORE_ID, CTRL_ID]));
        expect(recipients).not.toContain(FOREIGN_ID);
        expect(recipients).not.toContain(VENDOR);
        expect(rows[0].action_url).toBe(`/dashboard/buyer/inventory/reorder?hotelId=${A1}`);
        expect(rows[0].title).toMatch(/^1 item at or below reorder level/);
        expect(rows[0].message).toContain("Milk (4 of 10 litre)");

        const again = await runLowStockSweep({ conn: t, today: DAY });
        expect(again).toMatchObject({ digests: 0, alreadyDigested: 1 });
        expect(await digestRows()).toHaveLength(rows.length);
      });
    } finally {
      await db.none(
        `DELETE FROM tbl_notifications WHERE type = 'inventory_low_stock_digest' AND additional_data->>'date' = $1`,
        [DAY]
      );
    }
  });

  it("with no date given the digest is for today in IST, whatever the session zone", async () => {
    await withTx(async (t) => {
      await t.none(`SET LOCAL TIME ZONE 'UTC'`);
      await grantCast(t);
      await itemWith(t, { name: "Milk", reorderLevel: 10, maxQty: 50, qty: 4 });
      await startStock(t, A1);
      const notify = jest.fn(async () => ({ sent: true, recipients: 1 }));
      const out = await runLowStockSweep({ conn: t, notify });
      const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      expect(out).toMatchObject({ date: ist, digests: 1 });
      expect(notify.mock.calls[0][0].date).toBe(ist);
    });
  });

  it("a run that cannot take the lock is skipped", async () => {
    const holder = await db.connect();
    try {
      await holder.one(`SELECT pg_advisory_lock(950701, hashtext('inventory:low_stock_sweep'))`);
      const notify = jest.fn(async () => ({ sent: true }));
      expect(await runLowStockSweep({ today: DAY, notify })).toEqual({ skipped: true });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await holder.one(`SELECT pg_advisory_unlock(950701, hashtext('inventory:low_stock_sweep'))`);
      holder.done();
    }
  });
});

describe("over HTTP", () => {
  let scopes = [];
  let milk;
  let soap;
  let contract;
  const mrIds = [];

  /** The newest activity event for an entity, polled: capture runs after the response. */
  async function activityEvent(entityId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await db.oneOrNone(
        `SELECT event_key, hospitality_company_id, hotel_id, entity_label FROM tbl_activity_events
          WHERE entity_type = 'MR' AND entity_id = $1 AND event_key = 'inventory_reorder_mr_drafted' ORDER BY id DESC LIMIT 1`,
        [String(entityId)]
      );
      if (row || Date.now() > deadline) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  let priorUserType;

  beforeAll(async () => {
    // An MR is raised by a buyer (the MR routes' acl([2, 8])); fixture users carry user_type NULL.
    priorUserType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [STORE_ID])).user_type;
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [STORE_ID]);
    scopes = await grantCast(db);
    // ... holding mr.create at A1 for F&B
    scopes.push(await grantMr(db, STORE_ID, { departmentId: FB }));
    await db.tx(async (t) => {
      milk = await itemWith(t, { name: "HTTP milk", variantId: V[0], reorderLevel: 10, maxQty: 50, qty: 4 });
      soap = await itemWith(t, { name: "HTTP soap", stockUom: "pcs", variantId: V[1], reorderLevel: 10, maxQty: 40 });
      contract = await makeContract(t, { departmentId: FB, lines: [{ variantId: V[0], unitRate: 90 }] });
    });
  });
  afterAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [STORE_ID, priorUserType ?? null]);
    await revokeRoleScopes(db, scopes);
    if (mrIds.length) {
      await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = 'MR' AND entity_id::text = ANY($1::text[])`, [mrIds.map(String)]);
      await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [mrIds]);
    }
    if (contract) {
      await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contract.contractId]);
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [contract.arcId]);
    }
  });

  it("GET /reorder answers the worklist; a foreign hotel is 404", async () => {
    const store = await httpClient(STORE_ID);
    const res = await store.get(`/api/v1/inventory/reorder?hotelId=${A1}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.rows.find((r) => r.invItemId === milk)).toMatchObject({
      suggestedQty: 46, openMrQty: 0, contracted: { arcContractLineId: contract.lineIds[0], unitRate: 90 },
    });
    expect(res.body.data.can).toEqual({ createMrDraft: true });

    const foreign = await httpClient(FOREIGN_ID);
    const denied = await foreign.get(`/api/v1/inventory/reorder?hotelId=${A1}`);
    expect(denied.status).toBe(404);
  });

  it("POST /reorder/mr-draft creates the draft and records the activity with the hotel's scope", async () => {
    const store = await httpClient(STORE_ID);
    const res = await store.post("/api/v1/inventory/reorder/mr-draft").send({
      hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 46 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ mrId: expect.any(Number), hotelId: A1, departmentId: FB });
    mrIds.push(res.body.data.mrId);
    const trail = await activityEvent(res.body.data.mrId);
    expect(trail).toMatchObject({ hospitality_company_id: CO, hotel_id: A1, entity_label: res.body.data.mrNumber });

    const refused = await store.post("/api/v1/inventory/reorder/mr-draft").send({
      hotelId: A1, departmentId: FB, items: [{ invItemId: soap, qty: 30 }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "VALIDATION", details: { reason: "NOT_CONTRACTED", invItemId: soap } });

    const foreign = await httpClient(FOREIGN_ID);
    const denied = await foreign.post("/api/v1/inventory/reorder/mr-draft").send({
      hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 1 }],
    });
    expect(denied.status).toBe(404);
  });

  it("a repeated clientEventId answers 200 with the first draft and records no second activity row", async () => {
    const store = await httpClient(STORE_ID);
    const body = { hotelId: A1, departmentId: FB, clientEventId: randomUUID(), items: [{ invItemId: milk, qty: 3 }] };
    const first = await store.post("/api/v1/inventory/reorder/mr-draft").send(body);
    expect(first.status).toBe(201);
    mrIds.push(first.body.data.mrId);
    expect(await activityEvent(first.body.data.mrId)).toBeTruthy();

    const again = await store.post("/api/v1/inventory/reorder/mr-draft").send(body);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ ...first.body.data, replayed: true, no_op: true });
    // capture runs after the response: give a second row time to appear
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db.any(
      `SELECT id FROM tbl_activity_events WHERE entity_type = 'MR' AND entity_id = $1 AND event_key = 'inventory_reorder_mr_drafted'`,
      [String(first.body.data.mrId)]
    );
    expect(rows).toHaveLength(1);
  });

  it("403 without mr.create at the hotel and department, or on a non-buyer account; an unknown department is a 404 envelope", async () => {
    const body = { hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 1 }] };
    const noMrCreate = {
      status: 0,
      message: "You don't have permission to raise a material requisition for this department at this hotel",
      code: "FORBIDDEN",
      details: { resource: "mr", action: "create", hotelId: A1, departmentId: FB },
    };

    // CTRL holds inventory.update company-wide but is not a buyer (user_type NULL)
    const ctrl = await httpClient(CTRL_ID);
    const notBuyer = await ctrl.post("/api/v1/inventory/reorder/mr-draft").send(body);
    expect(notBuyer.status).toBe(403);
    expect(notBuyer.body).toMatchObject({ status: 0, code: "FORBIDDEN" });
    expect((await ctrl.get(`/api/v1/inventory/reorder?hotelId=${A1}`)).body.data.can).toEqual({ createMrDraft: false });

    // a buyer with inventory.read only, Storekeeper only, Inventory Controller
    // only, then mr.create for Engineering only: each sees the hotel and gets 403
    const viewer = IDS.users.a1_proc_techEval;
    const priorType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [viewer])).user_type;
    const role = Number((await db.one(
      `INSERT INTO tbl_roles (title, description, created_by) VALUES ('D3 HTTP viewer', 'reorder test', $1) RETURNING id`,
      [STORE_ID]
    )).id);
    let scope = [];
    try {
      await db.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions WHERE resource::text = 'inventory' AND action::text = 'read'`,
        [role]
      );
      await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [viewer]);
      const client = await httpClient(viewer);
      const holding = async (grants) => {
        await revokeRoleScopes(db, scope);
        scope = [];
        for (const g of grants) scope.push(await grantRoleScope(db, { userId: viewer, companyId: CO, ...g }));
        const post = await client.post("/api/v1/inventory/reorder/mr-draft").send(body);
        const get = await client.get(`/api/v1/inventory/reorder?hotelId=${A1}`);
        return { post: { status: post.status, body: post.body }, can: get.body.data?.can };
      };
      const refused = { post: { status: 403, body: noMrCreate }, can: { createMrDraft: false } };
      expect(await holding([{ roleId: role }])).toEqual(refused);
      expect(await holding([{ roleId: await roleId(db, "Storekeeper") }])).toEqual(refused);
      expect(await holding([{ roleId: await roleId(db, "Inventory Controller") }])).toEqual(refused);
      // mr.create at A1 for Engineering: the list offers a draft (for Engineering), F&B is refused
      expect(await holding([
        { roleId: await roleId(db, "Storekeeper") },
        { roleId: await roleId(db, "MR Raiser"), hotelId: A1, departmentId: IDS.departments.eng },
      ])).toEqual({ ...refused, can: { createMrDraft: true } });
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [viewer, priorType ?? null]);
      await revokeRoleScopes(db, scope);
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [role]);
      await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [role]);
    }

    // a department that does not exist: the inventory 404 envelope
    const store = await httpClient(STORE_ID);
    const ghost = await store.post("/api/v1/inventory/reorder/mr-draft").send({ ...body, departmentId: 999999 });
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual({
      status: 2, message: "Department not found", code: "NOT_FOUND", details: { field: "departmentId" },
    });
  });

  it("a platform super admin (user_type 8) raises the draft with no mr.create grant", async () => {
    const admin = IDS.users.a1_proc_commEval;
    const prior = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [admin])).user_type;
    try {
      await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [admin]);
      const held = await db.one(
        `SELECT count(*)::int AS n FROM tbl_user_role_scopes urs
           JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
           JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = $1 AND p.resource::text = 'mr' AND p.action::text = 'create'`,
        [admin]
      );
      expect(held.n).toBe(0);
      const client = await httpClient(admin);
      const list = await client.get(`/api/v1/inventory/reorder?hotelId=${A1}`);
      expect({ status: list.status, can: list.body.data?.can }).toEqual({ status: 200, can: { createMrDraft: true } });
      expect(list.body.data.departments.map((d) => d.id)).toEqual(expect.arrayContaining([FB]));
      const res = await client.post("/api/v1/inventory/reorder/mr-draft").send({
        hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 2 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ hotelId: A1, departmentId: FB, items: [{ invItemId: milk, quantity: 2 }] });
      mrIds.push(res.body.data.mrId);
      expect(await activityEvent(res.body.data.mrId)).toBeTruthy();
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [admin, prior ?? null]);
    }
  });
});
