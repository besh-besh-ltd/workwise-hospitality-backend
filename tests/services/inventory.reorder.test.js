// Reorder (Task D3, spec §9): the worklist (on hand, on order, suggested
// quantity, contracted lines), "Create MR draft" for contracted items, and the
// daily low-stock digest.
//
// Service cases run inside withTx. The HTTP cases and the digest's real
// notifier commit, so the suite truncates the dynamic tables before and after
// and deletes the MR / ARC / notification rows it committed.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
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

/** An ARC at the hotel and department with one active contract; lines [{variantId, unitRate, uom}]. */
async function makeContract(t, { hotelId = A1, departmentId = FB, vendorId = VENDOR, lines, status = "active" }) {
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
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, $3, 5, 1000) RETURNING id`,
      [contract.id, item.id, l.unitRate ?? 90]
    );
    lineIds.push(Number(line.id));
  }
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

      // a buyer scoped to Engineering at A1 sees no F&B or Housekeeping rates
      const eng = IDS.users.a1_eng_buyer;
      await grantRoleScope(t, { userId: eng, roleId: await roleId(t, "Storekeeper"), companyId: CO, hotelId: A1, departmentId: ENG });
      const engList = await getReorderList(t, { id: eng, user_type: 2 }, { hotelId: A1 });
      expect(engList.departments.map((d) => d.id)).toEqual([ENG]);
      expect(rowOf(engList, milk)).toMatchObject({ contracted: null, contractedLines: [], productVariantId: v });
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

  it("the hotel and department come from the caller's scope", async () => {
    await withTx(async (t) => {
      await grantCast(t);
      const milk = await itemWith(t, { name: "Milk", variantId: V[0], reorderLevel: 10, maxQty: 50 });
      await makeContract(t, { departmentId: FB, lines: [{ variantId: V[0] }] });
      const body = { hotelId: A1, departmentId: FB, items: [{ invItemId: milk, qty: 5 }] };

      // another company's hotel
      expect((await thrownBy(t, (sp) => createReorderMrDraft(sp, FOREIGN, body))).code).toBe("NOT_FOUND");

      // inventory.read without inventory.update: can see the hotel, cannot act
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
      expect((await thrownBy(t, (sp) => createReorderMrDraft(sp, { id: viewer, user_type: 2 }, body))).code).toBe("FORBIDDEN");

      // a storekeeper scoped to Engineering cannot raise an F&B requisition
      const eng = IDS.users.a1_eng_buyer;
      await grantRoleScope(t, { userId: eng, roleId: await roleId(t, "Storekeeper"), companyId: CO, hotelId: A1, departmentId: ENG });
      const engUser = { id: eng, user_type: 2 };
      const out = await thrownBy(t, (sp) => createReorderMrDraft(sp, engUser, body));
      expect(out.code).toBe("NOT_FOUND");
      expect(out.details).toMatchObject({ field: "departmentId" });
      // Engineering itself is in scope (milk just has no Engineering contract)
      const own = await thrownBy(t, (sp) => createReorderMrDraft(sp, engUser, { ...body, departmentId: ENG }));
      expect(own.details).toMatchObject({ reason: "NOT_CONTRACTED" });
      // an unknown department is not found either
      const ghost = await thrownBy(t, (sp) => createReorderMrDraft(sp, STORE, { ...body, departmentId: 999999 }));
      expect(ghost.code).toBe("NOT_FOUND");

      // a foreign item id is not found
      const other = await makeItem(t, { companyId: IDS.hospitality.B, name: "Company B item" });
      const foreignItem = await thrownBy(t, (sp) => createReorderMrDraft(sp, STORE, { ...body, items: [{ invItemId: other, qty: 1 }] }));
      expect(foreignItem.code).toBe("NOT_FOUND");
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
      suggestedQty: 46, contracted: { arcContractLineId: contract.lineIds[0], unitRate: 90 },
    });

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
});
