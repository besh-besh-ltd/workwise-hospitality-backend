// Fixtures for the stock suites (Task C3): mark out / return, adjustments,
// counts and the stock queries.
//
// Every builder takes the caller's connection, so a test inside withTx gets
// everything rolled back. Items are created directly in tbl_inv_item (no
// catalogue rows), and stock is put in with an OPENING movement through the
// real ledger.

import { IDS } from "../fixtures/ids.js";
import { grantRoleScope } from "./roleScope.js";
import { postMovements } from "../../app/services/inventory/ledger.js";

export const CO = IDS.hospitality.A;
export const CO_B = IDS.hospitality.B;
export const A1 = IDS.hotels.A1;
export const A2 = IDS.hotels.A2;
export const A3 = IDS.hotels.A3;
export const HB1 = IDS.hotels.B1;
export const FB = IDS.departments.fb;
export const HK = IDS.departments.hk;

/** Storekeeper: inventory read/create/update, company A. */
export const STORE_ID = IDS.users.a1_proc_buyer;
/** Inventory Controller (approve), company A. */
export const CTRL_ID = IDS.users.multiHotel;
/** A second Inventory Controller at hotel A1 only. */
export const CTRL2_ID = IDS.users.a1_proc_poApp;
/** Inventory Controller of company B. */
export const FOREIGN_ID = IDS.users.companyB_admin;

export const asUser = (id) => ({ id, user_type: 2 });
export const STORE = asUser(STORE_ID);
export const CTRL = asUser(CTRL_ID);
export const CTRL2 = asUser(CTRL2_ID);
export const FOREIGN = asUser(FOREIGN_ID);

let seq = 0;
export const tag = (prefix = "inv-c3") => `${prefix}-${process.pid}-${++seq}`;

export async function roleId(t, title) {
  return Number((await t.one(`SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`, [title])).id);
}

/** Grant a system role (by title); hotelId null = every hotel of the company. Returns the scope id. */
export async function grant(t, userId, title, { companyId = CO, hotelId = null } = {}) {
  return grantRoleScope(t, { userId, roleId: await roleId(t, title), companyId, hotelId });
}

/** The usual cast: STORE storekeeper and CTRL controller company-wide, FOREIGN controller of company B. */
export async function grantCast(t) {
  return [
    await grant(t, STORE_ID, "Storekeeper"),
    await grant(t, CTRL_ID, "Inventory Controller"),
    await grant(t, FOREIGN_ID, "Inventory Controller", { companyId: CO_B }),
  ];
}

export async function makeItem(t, { companyId = CO, name = `Item ${tag()}`, stockUom = "kg", itemCode = null } = {}) {
  const row = await t.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom, item_code)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, name, stockUom, itemCode]
  );
  return Number(row.id);
}

export async function setLevels(t, { companyId = CO, hotelId = A1, invItemId, minQty = null, reorderLevel = null, maxQty = null, binLabel = null }) {
  await t.none(
    `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, min_qty, reorder_level, max_qty, bin_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (hotel_id, inv_item_id) DO UPDATE
       SET min_qty = EXCLUDED.min_qty, reorder_level = EXCLUDED.reorder_level,
           max_qty = EXCLUDED.max_qty, bin_label = EXCLUDED.bin_label`,
    [hotelId, invItemId, companyId, minQty, reorderLevel, maxQty, binLabel]
  );
}

/** Put stock in with an OPENING movement at `unitCost` (or any other inbound type). */
export async function stockIn(t, { companyId = CO, hotelId = A1, invItemId, qty, unitCost = 100, type = "OPENING" }) {
  const [m] = await postMovements(t, [{
    companyId, hotelId, invItemId, type, qty, unitCost,
    sourceType: "ADJ", sourceId: 999999, postedBy: STORE_ID,
  }]);
  return m;
}

/** Any movement through the ledger (tests only; the services post their own). */
export async function move(t, { companyId = CO, hotelId = A1, invItemId, type, qty, unitCost, departmentId = null }) {
  const [m] = await postMovements(t, [{
    companyId, hotelId, invItemId, type, qty, unitCost, departmentId,
    sourceType: "ADJ", sourceId: 999999, postedBy: STORE_ID,
  }]);
  return m;
}

export async function balanceOf(t, hotelId, invItemId) {
  const row = await t.oneOrNone(
    `SELECT qty::float AS qty, avg_cost::float AS avg_cost, value::float AS value
       FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
    [hotelId, invItemId]
  );
  return row ? { qty: row.qty, avgCost: row.avg_cost, value: row.value } : { qty: 0, avgCost: 0, value: 0 };
}

export async function movementsOf(t, { sourceType, sourceId }) {
  return t.any(
    `SELECT movement_type AS type, inv_item_id, qty::float AS qty, unit_cost::float AS unit_cost,
            value::float AS value, department_id, reason_code, source_line_id
       FROM tbl_inv_movement WHERE source_type = $1 AND source_id = $2 ORDER BY id`,
    [sourceType, sourceId]
  );
}

export async function setCompanySettings(t, { companyId = CO, autoApproveLimit = 0, countFreeze = false, allowNegative = false } = {}) {
  await t.none(
    `INSERT INTO tbl_inv_company_settings
       (hospitality_company_id, adjustment_auto_approve_limit, count_freeze, allow_negative_stock)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hospitality_company_id) DO UPDATE
       SET adjustment_auto_approve_limit = EXCLUDED.adjustment_auto_approve_limit,
           count_freeze = EXCLUDED.count_freeze,
           allow_negative_stock = EXCLUDED.allow_negative_stock`,
    [companyId, autoApproveLimit, countFreeze, allowNegative]
  );
}

/** Run `fn` in a savepoint and return what it threw (fails the test when it does not throw). */
export async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

export async function istToday(t) {
  return (await t.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
}

export const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
