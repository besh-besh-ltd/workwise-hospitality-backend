// Inventory reports (Task D4): the ten inventory/receiving reports in the
// existing report registry, run through the real reports endpoints.
// ----------------------------------------------------------------------------
// One committed world is seeded once (the suite truncates the dynamic tables
// before and after): stock received, marked out, returned, adjusted and
// counted at hotels A1 and A2, back-dated stock for slow-moving, batches for
// near-expiry, a foreign company's stock at B1, and a vendor's phased
// deliveries for OTIF and pending deliveries. Every test reads that world
// through POST /reports/:key/preview (or /download) as a fixture user and
// asserts the rows a person would see, with known numbers.
//
// Scope comes from the caller's own role scopes: inventory.read hotels for the
// stock reports, grn.read hotels for the GRN, pending-delivery and OTIF
// reports. Entitlement (reports.<key>) is separate and scope-blind, exactly as
// for the procurement reports.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import excelJS from "exceljs";
import { db, closeDb, truncateDynamic } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { makeRfqPo, setPlan, postReceiptGrn } from "../helpers/invReceiptFixtures.js";
import { postMovements } from "../../app/services/inventory/ledger.js";
import { nextDocNumber } from "../../app/services/inventory/docNumber.js";
import { recomputePoReceipt } from "../../app/services/inventory/receiptRollup.js";
import { LEAF_CATEGORY_JOIN } from "../../app/models/reportsModel.js";
import { allReports } from "../../app/services/reports/definitions/index.js";
import { resolvePeriod } from "../../app/services/reports/filters.js";
import { SHORT_CLOSE_REASONS } from "../../app/services/inventory/shortCloseService.js";
import {
  SHORT_CLOSE_ATTRIBUTION,
  VENDOR_SHORT_CLOSE_REASONS,
} from "../../app/services/reports/definitions/vendorDeliveryPerformance.js";
import { LEDGER_REASON_LABELS } from "../../app/services/reports/definitions/stockLedger.js";

const CO_A = IDS.hospitality.A;
const CO_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const FB = IDS.departments.fb;
const HK = IDS.departments.hk;
const VENDOR = IDS.users.vendor_alpha;
const BUYER = IDS.users.a1_proc_buyer;

const WIDE = IDS.users.companyA_admin; // every report, inventory.read + grn.read company-wide
const NARROW = IDS.users.a1_eng_buyer; // every report, inventory.read + grn.read at A1 only
const PLAIN = IDS.users.a1_proc_buyer; // no report keys until a test grants one

const INVENTORY_KEYS = [
  "stock_on_hand",
  "stock_ledger",
  "grn_register",
  "pending_deliveries",
  "consumption_by_department",
  "stock_adjustments",
  "count_variance",
  "slow_moving",
  "near_expiry",
  "vendor_delivery_performance",
];

const roles = {};
const scopeIds = [];
let T; // today, IST
const W = {}; // the seeded world: ids, names and numbers the tests assert on

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** An instant on an IST calendar day, `n` days from today (10:00 IST). */
const istInstant = (n) => `${addDays(T, n)}T10:00:00+05:30`;

async function makeRole(title, perms) {
  const r = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'test-only role', $2) RETURNING id`,
    [title, IDS.users.superAdmin]
  );
  for (const [resource, actions] of Object.entries(perms)) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, id FROM tbl_permissions WHERE resource::text = $2 AND action::text = ANY($3::text[])`,
      [r.id, resource, actions]
    );
  }
  return Number(r.id);
}

async function grant(userId, roleId, hotelId = null, companyId = CO_A) {
  const id = await grantRoleScope(db, { userId, roleId, companyId, hotelId });
  scopeIds.push(id);
  return id;
}

async function makeItem(t, { companyId = CO_A, name, code, uom, variantId = null, trackExpiry = false }) {
  const row = await t.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, item_code, stock_uom, track_expiry)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, name, code, uom, trackExpiry]
  );
  if (variantId) {
    await t.none(
      `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id) VALUES ($1, $2, $3)`,
      [companyId, row.id, variantId]
    );
  }
  return Number(row.id);
}

/** A posted mark-out (OUT) or return-to-stock (RETURN) document, as C3 posts one. */
async function postOutDoc({ hotelId, docType, departmentId, lines }) {
  return db.tx(async (t) => {
    const outNumber = await nextDocNumber(t, { hotelId, docType: docType === "OUT" ? "OUT" : "RET" });
    const out = await t.one(
      `INSERT INTO tbl_inv_out (out_number, hospitality_company_id, hotel_id, doc_type, department_id, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [outNumber, CO_A, hotelId, docType, departmentId, BUYER]
    );
    const movements = [];
    for (const l of lines) {
      const line = await t.one(
        `INSERT INTO tbl_inv_out_line (hospitality_company_id, out_id, inv_item_id, qty) VALUES ($1, $2, $3, $4) RETURNING id`,
        [CO_A, out.id, l.invItemId, l.qty]
      );
      movements.push({
        companyId: CO_A, hotelId, invItemId: l.invItemId, type: docType === "OUT" ? "MARK_OUT" : "RETURN_IN",
        qty: docType === "OUT" ? -l.qty : l.qty, departmentId, sourceType: "OUT", sourceId: Number(out.id),
        sourceLineId: Number(line.id), postedBy: BUYER,
      });
    }
    await postMovements(t, movements);
    return outNumber;
  });
}

/** An adjustment; posted ones carry their ADJUST_IN / ADJUST_OUT movements. */
async function postAdjustment({ hotelId, reasonCode, status = "posted", lines }) {
  return db.tx(async (t) => {
    const number = await nextDocNumber(t, { hotelId, docType: "ADJ" });
    const adj = await t.one(
      `INSERT INTO tbl_inv_adjustment
         (adjustment_number, hospitality_company_id, hotel_id, reason_code, status, remarks, created_by,
          approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, 'seeded', $6, $7, $8) RETURNING id`,
      [number, CO_A, hotelId, reasonCode, status, BUYER, status === "posted" ? WIDE : null,
        status === "posted" ? new Date() : null]
    );
    const movements = [];
    for (const l of lines) {
      const line = await t.one(
        `INSERT INTO tbl_inv_adjustment_line (hospitality_company_id, adjustment_id, inv_item_id, qty, remarks)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [CO_A, adj.id, l.invItemId, l.qty, l.remarks ?? null]
      );
      movements.push({
        companyId: CO_A, hotelId, invItemId: l.invItemId, type: l.qty > 0 ? "ADJUST_IN" : "ADJUST_OUT", qty: l.qty,
        sourceType: "ADJ", sourceId: Number(adj.id), sourceLineId: Number(line.id), reasonCode, postedBy: WIDE,
      });
    }
    if (status === "posted") await postMovements(t, movements);
    return number;
  });
}

/** A count; an approved one posts its non-zero variances as COUNT_IN / COUNT_OUT. */
async function postCount({ hotelId, status, lines }) {
  return db.tx(async (t) => {
    const number = await nextDocNumber(t, { hotelId, docType: "CNT" });
    const approved = status === "approved";
    const cnt = await t.one(
      `INSERT INTO tbl_inv_count
         (count_number, hospitality_company_id, hotel_id, scope, status, submitted_at, approved_by, approved_at,
          created_by)
       VALUES ($1, $2, $3, 'FULL', $4, $5, $6, $7, $8) RETURNING id`,
      [number, CO_A, hotelId, status, approved ? new Date() : null, approved ? WIDE : null,
        approved ? new Date() : null, BUYER]
    );
    const movements = [];
    for (const l of lines) {
      const variance = l.counted - l.system;
      const line = await t.one(
        `INSERT INTO tbl_inv_count_line
           (hospitality_company_id, count_id, inv_item_id, counted_qty, system_qty_at_count, counted_at, counted_by,
            variance_qty, variance_value, reason)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9) RETURNING id`,
        [CO_A, cnt.id, l.invItemId, l.counted, l.system, BUYER, variance, variance * l.avg, l.reason ?? null]
      );
      if (variance !== 0) {
        movements.push({
          companyId: CO_A, hotelId, invItemId: l.invItemId, type: variance > 0 ? "COUNT_IN" : "COUNT_OUT",
          qty: variance, sourceType: "CNT", sourceId: Number(cnt.id), sourceLineId: Number(line.id),
          postedBy: WIDE,
        });
      }
    }
    if (approved) await postMovements(t, movements);
    return number;
  });
}

/**
 * A movement posted in the past. postMovements stamps now(), so stock that
 * has sat in the store for months is written straight to the (append-only)
 * ledger, with the running balance kept by hand: only items that never pass
 * through postMovements are seeded this way.
 */
async function backdatedMovement(t, m) {
  await t.none(
    `INSERT INTO tbl_inv_movement
       (hospitality_company_id, hotel_id, inv_item_id, movement_type, qty, unit_cost, value, qty_after,
        avg_cost_after, department_id, source_type, source_id, reason_code, posted_by, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)`,
    [CO_A, m.hotelId, m.invItemId, m.type, m.qty, m.unitCost, m.qty * m.unitCost, m.qtyAfter, m.unitCost,
      m.departmentId ?? null, m.sourceType, m.sourceId, m.reasonCode ?? null, BUYER, m.postedAt]
  );
}

async function seedWorld() {
  T = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;

  const names = await db.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [[A1, A2, B1]]);
  W.hotelName = Object.fromEntries(names.map((h) => [Number(h.id), h.name]));
  const depts = await db.any(`SELECT id, title FROM tbl_department WHERE id = ANY($1::int[])`, [[FB, HK]]);
  W.deptName = Object.fromEntries(depts.map((d) => [Number(d.id), d.title]));
  W.vendorName = (await db.one(
    `SELECT COALESCE(NULLIF(TRIM(vc.company_name), ''), NULLIF(TRIM(v.organization_name), ''), v.name) AS n
       FROM tbl_users v LEFT JOIN tbl_company vc ON vc.id = v.company_id WHERE v.id = $1`,
    [VENDOR]
  )).n;

  // Two catalogue variants in different leaf categories (rice / oil) and
  // eight more for the delivery world.
  const cats = await db.any(
    `SELECT pv.id, cat.title FROM tbl_product_variant pv ${LEAF_CATEGORY_JOIN}
      WHERE cat.title IS NOT NULL ORDER BY pv.id LIMIT 400`
  );
  const riceV = cats[0];
  const oilV = cats.find((c) => c.title !== riceV.title);
  const used = new Set([Number(riceV.id), Number(oilV.id)]);
  const spare = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 60`))
    .map((r) => Number(r.id)).filter((id) => !used.has(id));
  W.cat = { rice: riceV.title, oil: oilV.title };

  await db.tx(async (t) => {
    W.item = {
      rice: await makeItem(t, { name: "D4 Basmati Rice", code: "D4-RICE", uom: "kg", variantId: Number(riceV.id) }),
      oil: await makeItem(t, { name: "D4 Olive Oil", code: "D4-OIL", uom: "ltr", variantId: Number(oilV.id) }),
      milk: await makeItem(t, { name: "D4 Toned Milk", code: "D4-MILK", uom: "ltr", variantId: spare[0], trackExpiry: true }),
      soap: await makeItem(t, { name: "D4 Dish Soap", code: "D4-SOAP", uom: "nos" }),
      candle: await makeItem(t, { name: "D4 Candles", code: "D4-CANDLE", uom: "nos" }),
      sugar: await makeItem(t, { name: "D4 Sugar", code: "D4-SUGAR", uom: "kg", variantId: spare[1] }),
      vinegar: await makeItem(t, { name: "D4 Vinegar", code: "D4-VINEGAR", uom: "ltr", variantId: spare[2] }),
      flour: await makeItem(t, { name: "D4 Flour", code: "D4-FLOUR", uom: "kg", variantId: spare[3] }),
      salt: await makeItem(t, { name: "D4 Salt", code: "D4-SALT", uom: "kg", variantId: spare[4] }),
      pepper: await makeItem(t, { name: "D4 Pepper", code: "D4-PEPPER", uom: "kg", variantId: spare[5] }),
      tea: await makeItem(t, { name: "D4 Tea", code: "D4-TEA", uom: "kg", variantId: spare[6] }),
      coffee: await makeItem(t, { name: "D4 Coffee", code: "D4-COFFEE", uom: "kg", variantId: spare[7] }),
      mint: await makeItem(t, { name: "D4 Mint", code: "D4-MINT", uom: "kg", variantId: spare[8] }),
      saffron: await makeItem(t, { name: "D4 Saffron", code: "D4-SAFFRON", uom: "g" }),
      matches: await makeItem(t, { name: "D4 Matches", code: "D4-MATCHES", uom: "nos" }),
      wicks: await makeItem(t, { name: "D4 Wicks", code: "D4-WICKS", uom: "nos" }),
      bRice: await makeItem(t, { companyId: CO_B, name: "D4 Foreign Rice", code: "D4-BRICE", uom: "kg" }),
    };
  });
  W.variant = { rice: Number(riceV.id), oil: Number(oilV.id), milk: spare[0], sugar: spare[1], vinegar: spare[2],
    flour: spare[3], salt: spare[4], pepper: spare[5], tea: spare[6], coffee: spare[7], mint: spare[8] };

  // ── Stock received at A1 and A2 ─────────────────────────────────────────
  W.grn = {};
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, {
      hotel: A1,
      lines: [
        { qty: 100, unit: "kg", variantId: W.variant.rice, unitPrice: 50 },
        { qty: 20, unit: "ltr", variantId: W.variant.oil, unitPrice: 200 },
        { qty: 12, unit: "ltr", variantId: W.variant.milk, unitPrice: 40 },
      ],
    });
    W.stockPoA1 = po.poNumber;
    W.grn.G1 = (await postReceiptGrn(t, {
      poId: po.poId, hotelId: A1, receivedAt: T,
      lines: [
        { poLineId: po.lineIds[0], accepted: 100, unitCost: 50 },
        { poLineId: po.lineIds[1], accepted: 20, unitCost: 200 },
        { poLineId: po.lineIds[2], accepted: 12, unitCost: 40, batchNo: "M-1", expiryDate: addDays(T, 10) },
      ],
    })).grnNumber;
  });
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A2, lines: [{ qty: 40, unit: "kg", variantId: W.variant.rice, unitPrice: 55 }] });
    W.grn.G2 = (await postReceiptGrn(t, {
      poId: po.poId, hotelId: A2, receivedAt: T, lines: [{ poLineId: po.lineIds[0], accepted: 40, unitCost: 55 }],
    })).grnNumber;
  });

  // ── Marked out, returned, adjusted, counted ─────────────────────────────
  W.doc = {};
  W.doc.O1 = await postOutDoc({ hotelId: A1, docType: "OUT", departmentId: FB,
    lines: [{ invItemId: W.item.rice, qty: 30 }, { invItemId: W.item.oil, qty: 4 }] });
  W.doc.R1 = await postOutDoc({ hotelId: A1, docType: "RETURN", departmentId: FB, lines: [{ invItemId: W.item.rice, qty: 5 }] });
  W.doc.O2 = await postOutDoc({ hotelId: A1, docType: "OUT", departmentId: HK, lines: [{ invItemId: W.item.rice, qty: 10 }] });
  W.doc.O3 = await postOutDoc({ hotelId: A2, docType: "OUT", departmentId: FB, lines: [{ invItemId: W.item.rice, qty: 8 }] });
  W.doc.ADJ1 = await postAdjustment({ hotelId: A1, reasonCode: "WASTAGE",
    lines: [{ invItemId: W.item.rice, qty: -2, remarks: "rats" }] });
  W.doc.ADJ2 = await postAdjustment({ hotelId: A1, reasonCode: "FOUND", lines: [{ invItemId: W.item.oil, qty: 1 }] });
  W.doc.ADJ3 = await postAdjustment({ hotelId: A1, reasonCode: "BREAKAGE", status: "pending_approval",
    lines: [{ invItemId: W.item.oil, qty: -1 }] });
  W.doc.CNT1 = await postCount({ hotelId: A1, status: "approved", lines: [
    { invItemId: W.item.rice, system: 63, counted: 62, avg: 50, reason: "spillage" },
    { invItemId: W.item.oil, system: 17, counted: 17, avg: 200 },
    { invItemId: W.item.milk, system: 12, counted: 12, avg: 40 },
  ] });
  W.doc.CNT2 = await postCount({ hotelId: A1, status: "open", lines: [
    { invItemId: W.item.oil, system: 17, counted: 15, avg: 200, reason: "not yet approved" },
  ] });

  // ── A write-off residue (A2's ledger sequence, at A1) ──────────────────
  // 10 @100 + 5 @400 (avg 200), 9 out at 200, then the dearer lot reversed at
  // its receipt cost: the balance ends at qty 1, value 0, while the movement
  // values sum to −800. The out is a count loss and the documents are made
  // up, so no flow report picks these rows up.
  const saffron = (type, qty, extra = {}) => ({
    companyId: CO_A, hotelId: A1, invItemId: W.item.saffron, type, qty, sourceType: type === "COUNT_OUT" ? "CNT" : "GRN",
    sourceId: 999999, postedBy: BUYER, ...extra,
  });
  await db.tx((t) => postMovements(t, [saffron("GRN_IN", 10, { unitCost: 100 }), saffron("GRN_IN", 5, { unitCost: 400 })]));
  await db.tx((t) => postMovements(t, [saffron("COUNT_OUT", -9)]));
  await db.tx((t) => postMovements(t, [saffron("GRN_REVERSAL", -5, { unitCost: 400 })]));

  // ── Stock that has sat for months (A1), and a foreign company's (B1) ────
  await db.tx(async (t) => {
    const opening = await t.one(
      `INSERT INTO tbl_inv_adjustment (adjustment_number, hospitality_company_id, hotel_id, reason_code, status, created_by)
       VALUES ('ADJ/D4/OPENING', $1, $2, 'OPENING', 'posted', $3) RETURNING id`,
      [CO_A, A1, BUYER]
    );
    const oldOut = await t.one(
      `INSERT INTO tbl_inv_out (out_number, hospitality_company_id, hotel_id, doc_type, department_id, posted_by, posted_at)
       VALUES ('OUT/D4/OLD', $1, $2, 'OUT', $3, $4, $5::timestamptz) RETURNING id`,
      [CO_A, A1, FB, BUYER, istInstant(-120)]
    );
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.soap, type: "OPENING", qty: 10, unitCost: 30,
      qtyAfter: 10, sourceType: "ADJ", sourceId: opening.id, reasonCode: "OPENING", postedAt: istInstant(-200) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.candle, type: "OPENING", qty: 5, unitCost: 20,
      qtyAfter: 5, sourceType: "ADJ", sourceId: opening.id, reasonCode: "OPENING", postedAt: istInstant(-150) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.candle, type: "MARK_OUT", qty: -1, unitCost: 20,
      qtyAfter: 4, departmentId: FB, sourceType: "OUT", sourceId: oldOut.id, postedAt: istInstant(-120) });
    // Matches: held a year ago, used up (a count loss) long before the
    // slow-moving cut-off, received again 10 days ago: nothing on hand at
    // the cut-off. Wicks: on hand at the cut-off, but ran out 60 days ago and
    // was received again: not held for the whole window. Neither is idle.
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.matches, type: "OPENING", qty: 5, unitCost: 10,
      qtyAfter: 5, sourceType: "ADJ", sourceId: opening.id, reasonCode: "OPENING", postedAt: istInstant(-400) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.matches, type: "COUNT_OUT", qty: -5, unitCost: 10,
      qtyAfter: 0, sourceType: "CNT", sourceId: 999999, postedAt: istInstant(-350) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.matches, type: "GRN_IN", qty: 3, unitCost: 40,
      qtyAfter: 3, sourceType: "GRN", sourceId: 999999, postedAt: istInstant(-10) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.wicks, type: "OPENING", qty: 6, unitCost: 5,
      qtyAfter: 6, sourceType: "ADJ", sourceId: opening.id, reasonCode: "OPENING", postedAt: istInstant(-400) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.wicks, type: "COUNT_OUT", qty: -6, unitCost: 5,
      qtyAfter: 0, sourceType: "CNT", sourceId: 999999, postedAt: istInstant(-60) });
    await backdatedMovement(t, { hotelId: A1, invItemId: W.item.wicks, type: "GRN_IN", qty: 2, unitCost: 5,
      qtyAfter: 2, sourceType: "GRN", sourceId: 999999, postedAt: istInstant(-30) });
    await t.none(
      `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id, qty, avg_cost, value, last_movement_at)
       VALUES ($1, $2, $3, 10, 30, 300, $4::timestamptz), ($1, $5, $3, 4, 20, 80, $6::timestamptz),
              ($1, $7, $3, 3, 40, 120, $8::timestamptz), ($1, $9, $3, 2, 5, 10, $10::timestamptz)`,
      [A1, W.item.soap, CO_A, istInstant(-200), W.item.candle, istInstant(-120), W.item.matches, istInstant(-10),
        W.item.wicks, istInstant(-30)]
    );
  });
  await db.tx(async (t) => {
    await postMovements(t, [{ companyId: CO_B, hotelId: B1, invItemId: W.item.bRice, type: "OPENING", qty: 7,
      unitCost: 10, sourceType: "ADJ", sourceId: 1, reasonCode: "OPENING", postedBy: IDS.users.companyB_admin }]);
  });

  // ── Batches for near-expiry ─────────────────────────────────────────────
  // The ledger keeps the batches of tracked items it posts (G1's M-1 for milk
  // is already there); the others stand in for stock seeded around it. The
  // seed states the quantities either way. Rice, oil and B's rice track
  // expiry from here on (their movements are all posted above); soap does
  // not, so its leftover batch (an item whose tracking was switched off) must
  // not be reported.
  await db.none(`UPDATE tbl_inv_item SET track_expiry = true WHERE id = ANY($1::int[])`, [
    [W.item.rice, W.item.oil, W.item.bRice],
  ]);
  await db.none(
    `INSERT INTO tbl_inv_batch (hospitality_company_id, hotel_id, inv_item_id, batch_no, expiry_date, qty) VALUES
       ($1, $2, $3, 'M-1', $4, 12), ($1, $2, $5, 'R-OLD', $6, 5), ($1, $2, $7, 'O-LATE', $8, 5),
       ($1, $2, $7, 'O-ZERO', $9, 0), ($1, $10, $5, 'R-A2', $11, 6), ($12, $13, $14, 'B-1', $15, 7),
       ($1, $2, $16, 'S-UNTRACKED', $9, 4)
     ON CONFLICT (hotel_id, inv_item_id, batch_no, expiry_date) DO UPDATE SET qty = EXCLUDED.qty`,
    [CO_A, A1, W.item.milk, addDays(T, 10), W.item.rice, addDays(T, -3), W.item.oil, addDays(T, 45),
      addDays(T, 5), A2, addDays(T, 20), CO_B, B1, W.item.bRice, addDays(T, 1), W.item.soap]
  );

  // ── Vendor deliveries (OTIF, pending) ───────────────────────────────────
  W.po = {};
  // PO-X at A1: phase 1 early and in full; phase 2 late and short (2 of 10 rejected).
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A1, lines: [
      { qty: 100, unit: "kg", variantId: W.variant.sugar, unitPrice: 10 },
      { qty: 20, unit: "ltr", variantId: W.variant.vinegar, unitPrice: 30 },
    ] });
    const [lx1, lx2] = po.lineIds;
    const [d1, d2] = await setPlan(t, po.poId, [
      { hotelId: A1, phaseNo: 1, dueDate: addDays(T, -10), lines: { [lx1]: 60, [lx2]: 10 } },
      { hotelId: A1, phaseNo: 2, dueDate: addDays(T, -5), lines: { [lx1]: 40, [lx2]: 10 } },
    ]);
    W.po.X = po.poNumber;
    W.grn.X1 = (await postReceiptGrn(t, { poId: po.poId, hotelId: A1, receivedAt: addDays(T, -12), lines: [
      { poLineId: lx1, accepted: 60, unitCost: 10, deliveryLineId: d1.lines[lx1] },
      { poLineId: lx2, accepted: 10, unitCost: 30, deliveryLineId: d1.lines[lx2] },
    ] })).grnNumber;
    W.grn.X2 = (await postReceiptGrn(t, { poId: po.poId, hotelId: A1, receivedAt: addDays(T, -3), lines: [
      { poLineId: lx1, accepted: 40, unitCost: 10, deliveryLineId: d2.lines[lx1] },
      { poLineId: lx2, accepted: 8, rejected: 2, rejectionReason: "damaged", unitCost: 30, deliveryLineId: d2.lines[lx2] },
    ] })).grnNumber;
  });
  // PO-Y at A1: phase 1 received on its due date, then short-closed; phase 2 never came.
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 40, unit: "kg", variantId: W.variant.flour, unitPrice: 20 }] });
    const [ly] = po.lineIds;
    const [d3] = await setPlan(t, po.poId, [
      { hotelId: A1, phaseNo: 1, dueDate: addDays(T, -8), lines: { [ly]: 30 } },
      { hotelId: A1, phaseNo: 2, dueDate: addDays(T, -2), lines: { [ly]: 10 } },
    ]);
    W.po.Y = po.poNumber;
    W.grn.Y1 = (await postReceiptGrn(t, { poId: po.poId, hotelId: A1, receivedAt: addDays(T, -8), lines: [
      { poLineId: ly, accepted: 20, unitCost: 20, deliveryLineId: d3.lines[ly] },
    ] })).grnNumber;
    await t.none(
      `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, action, acted_by)
       VALUES ($1, $2, $3, 10, 'vendor_cannot_supply', 'close', $4)`,
      [CO_A, po.poId, d3.lines[ly], BUYER]
    );
    await recomputePoReceipt(t, po.poId);
  });
  // PO-N at A1: 12 of 20 arrived early; a vendor short-close of 5 was
  // reopened, then the buyer closed the last 8 as no longer needed. Only the
  // buyer's close is in force, so the row is excluded from OTIF, not failed.
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 20, unit: "kg", variantId: W.variant.mint, unitPrice: 15 }] });
    const [ln] = po.lineIds;
    const [dn] = await setPlan(t, po.poId, [{ hotelId: A1, phaseNo: 1, dueDate: addDays(T, -4), lines: { [ln]: 20 } }]);
    W.po.N = po.poNumber;
    W.grn.N1 = (await postReceiptGrn(t, { poId: po.poId, hotelId: A1, receivedAt: addDays(T, -6), lines: [
      { poLineId: ln, accepted: 12, unitCost: 15, deliveryLineId: dn.lines[ln] },
    ] })).grnNumber;
    await t.none(
      `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, remarks, action, acted_by)
       VALUES ($1, $2, $3, 5, 'vendor_cannot_supply', NULL, 'close', $4)`,
      [CO_A, po.poId, dn.lines[ln], BUYER]
    );
    await t.none(
      `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, remarks, action, acted_by)
       VALUES ($1, $2, $3, 5, NULL, 'vendor found stock', 'reopen', $4)`,
      [CO_A, po.poId, dn.lines[ln], BUYER]
    );
    await t.none(
      `INSERT INTO tbl_po_short_close (hospitality_company_id, po_id, delivery_line_id, qty, reason_code, remarks, action, acted_by)
       VALUES ($1, $2, $3, 8, 'no_longer_needed', NULL, 'close', $4)`,
      [CO_A, po.poId, dn.lines[ln], BUYER]
    );
    await recomputePoReceipt(t, po.poId);
  });
  // PO-Z at A1: due next week (not judged yet).
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 10, unit: "kg", variantId: W.variant.salt, unitPrice: 5 }] });
    await setPlan(t, po.poId, [{ hotelId: A1, phaseNo: 1, dueDate: addDays(T, 5), lines: { [po.lineIds[0]]: 10 } }]);
    W.po.Z = po.poNumber;
  });
  // PO-L at A1: a legacy (pre-module) order, overdue but excluded everywhere.
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A1, lines: [{ qty: 10, unit: "kg", variantId: W.variant.pepper, unitPrice: 5 }] });
    await setPlan(t, po.poId, [{ hotelId: A1, phaseNo: 1, dueDate: addDays(T, -20), lines: { [po.lineIds[0]]: 10 } }]);
    await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [po.poId]);
    W.po.L = po.poNumber;
  });
  // PO-A2: early and in full at A2.
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A2, lines: [{ qty: 10, unit: "kg", variantId: W.variant.tea, unitPrice: 100 }] });
    const [d7] = await setPlan(t, po.poId, [{ hotelId: A2, phaseNo: 1, dueDate: addDays(T, -6), lines: { [po.lineIds[0]]: 10 } }]);
    W.po.A2 = po.poNumber;
    W.grn.A21 = (await postReceiptGrn(t, { poId: po.poId, hotelId: A2, receivedAt: addDays(T, -7), lines: [
      { poLineId: po.lineIds[0], accepted: 10, unitCost: 100, deliveryLineId: d7.lines[po.lineIds[0]] },
    ] })).grnNumber;
  });
  // PO-U at A2: planned but not yet scheduled.
  await db.tx(async (t) => {
    const po = await makeRfqPo(t, { hotel: A2, lines: [{ qty: 5, unit: "kg", variantId: W.variant.coffee, unitPrice: 50 }] });
    await setPlan(t, po.poId, [{ hotelId: A2, phaseNo: 1, dueDate: null, lines: { [po.lineIds[0]]: 5 } }]);
    W.po.U = po.poNumber;
  });
}

beforeAll(async () => {
  await truncateDynamic();
  roles.all = await makeRole("TEST D4 inventory reports", {
    inventory: ["read"], grn: ["read"], reports: INVENTORY_KEYS,
  });
  roles.sohOnly = await makeRole("TEST D4 stock on hand only", { reports: ["stock_on_hand"] });
  roles.invRead = await makeRole("TEST D4 inventory read", { inventory: ["read"] });
  await grant(WIDE, roles.all, null);
  await grant(NARROW, roles.all, A1);
  await seedWorld();
}, 120000);

afterAll(async () => {
  await revokeRoleScopes(db, scopeIds);
  await db.none(`DELETE FROM tbl_report_exports WHERE requested_by = ANY($1::int[])`, [[WIDE, NARROW, PLAIN]]);
  for (const id of Object.values(roles)) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [id]);
  }
  await truncateDynamic();
  await closeDb();
});

// ── helpers ──────────────────────────────────────────────────────────────

const RECENT = () => ({ from: addDays(T, -60), to: addDays(T, 1) });

async function preview(userId, key, body = {}) {
  const client = await httpClient(userId);
  const res = await client.post(`/api/v1/reports/${key}/preview`).send(body);
  return res;
}

async function rowsOf(userId, key, body = {}) {
  const res = await preview(userId, key, body);
  expect(res.status).toBe(200);
  return res.body.data.rows;
}

const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function download(userId, key, body = {}) {
  const client = await httpClient(userId);
  const res = await binary(client.post(`/api/v1/reports/${key}/download`).send(body));
  expect(res.status).toBe(200);
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}

/** A report sheet's body as objects keyed by header text (header row = first cell `firstHeader`). */
function sheetRows(ws, firstHeader) {
  let headerRow = null;
  for (let r = 1; r <= ws.rowCount; r += 1) {
    if (String(ws.getRow(r).getCell(1).value ?? "") === firstHeader) { headerRow = r; break; }
  }
  if (!headerRow) throw new Error(`no header "${firstHeader}" in ${ws.name}`);
  const heads = [];
  ws.getRow(headerRow).eachCell((c, i) => { heads[i] = String(c.value); });
  const out = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const first = ws.getRow(r).getCell(1).value;
    if (first === null || first === undefined || first === "" || first === "Total") break;
    const o = {};
    heads.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i).value; });
    out.push(o);
  }
  return out;
}

const byItem = (rows, code, hotelId) =>
  rows.filter((r) => r.item_code === code && (hotelId == null || r.hotel_name === W.hotelName[hotelId]));

// ============================================================================

describe("inventory reports in the catalogue", () => {
  it("lists all ten inventory reports as runnable for a user holding them", async () => {
    const client = await httpClient(WIDE);
    const res = await client.get("/api/v1/reports/catalogue");
    expect(res.status).toBe(200);
    const inv = res.body.data.reports.filter((r) => INVENTORY_KEYS.includes(r.key));
    expect(inv.map((r) => r.key).sort()).toEqual([...INVENTORY_KEYS].sort());
    for (const r of inv) {
      expect(r.runnable).toBe(true);
      expect(r.readiness.state).toBe("ready");
      expect(["Inventory", "Receiving & Deliveries"]).toContain(r.family);
    }
  });

  it("report permission gates access", async () => {
    // No reports.* key: not listed, and the run endpoint refuses.
    let client = await httpClient(PLAIN);
    let cat = await client.get("/api/v1/reports/catalogue");
    expect(cat.body.data.reports.filter((r) => INVENTORY_KEYS.includes(r.key))).toEqual([]);
    expect((await preview(PLAIN, "stock_on_hand")).status).toBe(403);

    // The key alone is entitlement, not scope: listed and runnable, but with
    // no inventory.read anywhere there is nothing to see.
    const sohScope = await grant(PLAIN, roles.sohOnly, null);
    client = await httpClient(PLAIN);
    cat = await client.get("/api/v1/reports/catalogue");
    const listed = cat.body.data.reports.filter((r) => INVENTORY_KEYS.includes(r.key));
    expect(listed.map((r) => r.key)).toEqual(["stock_on_hand"]);
    expect(listed[0]).toMatchObject({ family: "Inventory", runnable: true });
    let res = await preview(PLAIN, "stock_on_hand");
    expect(res.status).toBe(200);
    expect(res.body.data.total_rows).toBe(0);
    expect((await preview(PLAIN, "grn_register")).status).toBe(403);

    // inventory.read at A1 opens A1's rows and nothing else.
    const readScope = await grant(PLAIN, roles.invRead, A1);
    res = await preview(PLAIN, "stock_on_hand");
    expect(res.status).toBe(200);
    expect(res.body.data.total_rows).toBeGreaterThan(0);
    expect(new Set(res.body.data.rows.map((r) => r.hotel_name))).toEqual(new Set([W.hotelName[A1]]));

    await revokeRoleScopes(db, [sohScope, readScope]);
  });
});

describe("stock reports", () => {
  it("stock_on_hand returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "stock_on_hand");
    const pick = (code, hotel) => {
      const found = byItem(rows, code, hotel);
      expect(found).toHaveLength(1);
      return found[0];
    };
    expect(pick("D4-RICE", A1)).toMatchObject({ item_name: "D4 Basmati Rice", stock_uom: "kg", qty: 62, value: 3100, avg_cost: 50 });
    expect(pick("D4-OIL", A1)).toMatchObject({ qty: 17, value: 3400, avg_cost: 200 });
    expect(pick("D4-MILK", A1)).toMatchObject({ qty: 12, value: 480 });
    expect(pick("D4-SOAP", A1)).toMatchObject({ qty: 10, value: 300 });
    expect(pick("D4-CANDLE", A1)).toMatchObject({ qty: 4, value: 80 });
    expect(pick("D4-RICE", A2)).toMatchObject({ qty: 32, value: 1760, avg_cost: 55 });
    expect(pick("D4-VINEGAR", A1)).toMatchObject({ qty: 18, value: 540 });
    // Another company's store never appears.
    expect(rows.some((r) => r.item_code === "D4-BRICE")).toBe(false);

    // A past period reports the stock as it stood at the end of it: the
    // last movement's qty_after × avg_cost_after. Wicks were still held
    // then; the matches had been used up.
    const then = await rowsOf(WIDE, "stock_on_hand", { from: addDays(T, -300), to: addDays(T, -100) });
    expect(then.map((r) => [r.item_code, r.qty, r.avg_cost, r.value])).toEqual([
      ["D4-CANDLE", 4, 20, 80],
      ["D4-SOAP", 10, 30, 300],
      ["D4-WICKS", 6, 5, 30],
    ]);
  });

  it("stock_on_hand values a write-off residue as the balance does, not as the movement sum", async () => {
    const balance = await db.one(
      `SELECT qty::float8 AS qty, avg_cost::float8 AS avg_cost, value::float8 AS value
         FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2`,
      [A1, W.item.saffron]
    );
    const { sum } = await db.one(
      `SELECT sum(value)::float8 AS sum FROM tbl_inv_movement WHERE hotel_id = $1 AND inv_item_id = $2`,
      [A1, W.item.saffron]
    );
    expect(balance).toEqual({ qty: 1, avg_cost: 0, value: 0 });
    expect(sum).toBe(-800);

    const rows = await rowsOf(WIDE, "stock_on_hand");
    const [saffron] = byItem(rows, "D4-SAFFRON", A1);
    expect(saffron).toMatchObject({ qty: balance.qty, avg_cost: balance.avg_cost, value: balance.value });

    // The By Hotel summary adds the same figures.
    const wb = await download(WIDE, "stock_on_hand");
    const sheet = sheetRows(wb.getWorksheet("Stock on Hand"), "Hotel");
    const a1Total = sheet.filter((r) => r.Hotel === W.hotelName[A1]).reduce((acc, r) => acc + r["Value (₹)"], 0);
    const summary = sheetRows(wb.getWorksheet("By Hotel"), "Hotel").find((r) => r.Hotel === W.hotelName[A1]);
    expect(summary["Stock Value (₹)"]).toBeCloseTo(a1Total, 4);
    const { v } = await db.one(
      `SELECT sum(value)::float8 AS v FROM tbl_inv_balance WHERE hotel_id = $1 AND qty <> 0`,
      [A1]
    );
    expect(summary["Stock Value (₹)"]).toBeCloseTo(v, 4);
  });

  it("stock_ledger returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "stock_ledger", RECENT());
    const wb = await download(WIDE, "stock_ledger", RECENT());
    const all = sheetRows(wb.getWorksheet("Stock Ledger"), "Hotel");
    expect(all.length).toBeGreaterThanOrEqual(rows.length);

    const rice = all.filter((r) => r["Item Code"] === "D4-RICE" && r.Hotel === W.hotelName[A1]);
    expect(rice.map((r) => [r.Movement, r.Document, r["Qty In"] ?? null, r["Qty Out"] ?? null, r["Value (₹)"], r["Balance Qty"]]))
      .toEqual([
        ["Receipt (GRN)", W.grn.G1, 100, null, 5000, 100],
        ["Mark out", W.doc.O1, null, 30, -1500, 70],
        ["Return to stock", W.doc.R1, 5, null, 250, 75],
        ["Mark out", W.doc.O2, null, 10, -500, 65],
        ["Adjustment out", W.doc.ADJ1, null, 2, -100, 63],
        ["Count loss", W.doc.CNT1, null, 1, -50, 62],
      ]);
    expect(rice[1].Department).toBe(W.deptName[FB]);
    expect(rice[4].Reason).toBe("Wastage");
    // Back-dated stock is outside the window.
    expect(all.some((r) => r["Item Code"] === "D4-SOAP")).toBe(false);
    expect(all.some((r) => r["Item Code"] === "D4-BRICE")).toBe(false);

    const old = await rowsOf(WIDE, "stock_ledger", { from: addDays(T, -300), to: addDays(T, -100) });
    expect(old.map((r) => [r.item_code, r.movement, r.qty_in, r.qty_out])).toEqual([
      ["D4-CANDLE", "Opening stock", 5, null],
      ["D4-CANDLE", "Mark out", null, 1],
      ["D4-SOAP", "Opening stock", 10, null],
    ]);
    expect(old[1].doc_number).toBe("OUT/D4/OLD");
  });

  it("consumption_by_department returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "consumption_by_department", RECENT());
    const fb = W.deptName[FB];
    const hk = W.deptName[HK];
    expect(rows.map((r) => [r.department_name, r.category, r.out_value, r.return_value, r.net_value])).toEqual(
      expect.arrayContaining([
        [fb, W.cat.rice, 1940, 250, 1690],
        [fb, W.cat.oil, 800, 0, 800],
        [hk, W.cat.rice, 500, 0, 500],
      ])
    );
    expect(rows).toHaveLength(3);
    // The candle issued 120 days ago is outside the window.
    const old = await rowsOf(WIDE, "consumption_by_department", { from: addDays(T, -300), to: addDays(T, -100) });
    expect(old.map((r) => [r.department_name, r.category, r.net_value])).toEqual([[fb, "Uncategorised", 20]]);

    const wb = await download(WIDE, "consumption_by_department", RECENT());
    const items = sheetRows(wb.getWorksheet("By Item"), "Department");
    const a1Rice = items.find((r) => r.Department === fb && r.Hotel === W.hotelName[A1] && r["Item Code"] === "D4-RICE");
    expect(a1Rice).toMatchObject({ "Qty Out": 30, "Qty Returned": 5, "Net Qty": 25, "Net Value (₹)": 1250 });
  });

  it("stock_adjustments returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "stock_adjustments", RECENT());
    expect(rows.map((r) => [r.adjustment_number, r.reason, r.item_code, r.qty, r.value])).toEqual([
      [W.doc.ADJ1, "Wastage", "D4-RICE", -2, -100],
      [W.doc.ADJ2, "Found", "D4-OIL", 1, 200],
    ]);
    expect(rows[0]).toMatchObject({ hotel_name: W.hotelName[A1], remarks: "rats" });
    // The pending breakage has not touched stock, so it is not reported.
    expect(rows.some((r) => r.adjustment_number === W.doc.ADJ3)).toBe(false);
  });

  it("count_variance returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "count_variance", RECENT());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count_number: W.doc.CNT1, hotel_name: W.hotelName[A1], item_code: "D4-RICE",
      system_qty: 63, counted_qty: 62, variance_qty: -1, value: -50, reason: "spillage",
    });
  });

  it("slow_moving returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "slow_moving");
    // Matches (nothing on hand at the cut-off), wicks (ran out since) and
    // saffron (first received today) are not idle stock.
    expect(rows.map((r) => [r.item_code, r.status, r.qty, r.value, r.days_since_outbound])).toEqual([
      ["D4-SOAP", "Non-moving", 10, 300, null],
      ["D4-CANDLE", "Slow-moving", 4, 80, 120],
    ]);
    expect(rows.map((r) => r.days_in_store)).toEqual([200, 150]);
  });

  it("slow_moving needs stock on hand at the cut-off, not just an old first movement", async () => {
    const rows = await rowsOf(WIDE, "slow_moving");
    const codes = rows.map((r) => r.item_code);
    // First movement 400 days ago, never marked out, qty > 0 today: the old
    // rule called both non-moving.
    expect(codes).not.toContain("D4-MATCHES");
    expect(codes).not.toContain("D4-WICKS");
  });

  // E1 M-1: soap's batch S-UNTRACKED expires in 5 days, but soap does not
  // track expiry, so it is not listed.
  it("near_expiry returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "near_expiry");
    expect(rows.map((r) => [r.hotel_name, r.item_code, r.batch_no, r.days_to_expiry, r.status, r.qty])).toEqual([
      [W.hotelName[A1], "D4-RICE", "R-OLD", -3, "Expired", 5],
      [W.hotelName[A1], "D4-MILK", "M-1", 10, "Expiring", 12],
      [W.hotelName[A2], "D4-RICE", "R-A2", 20, "Expiring", 6],
    ]);
  });
});

describe("receiving reports", () => {
  it("grn_register returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "grn_register", RECENT());
    expect(rows.map((r) => r.grn_number)).toEqual([W.grn.X1, W.grn.Y1, W.grn.A21, W.grn.N1, W.grn.X2, W.grn.G1, W.grn.G2]);
    const g1 = rows.find((r) => r.grn_number === W.grn.G1);
    expect(g1).toMatchObject({
      type: "Receipt", hotel_name: W.hotelName[A1], po_number: W.stockPoA1, vendor_name: W.vendorName,
      line_count: 3, rejected_lines: 0, value: 9480,
    });
    expect(rows.find((r) => r.grn_number === W.grn.X2)).toMatchObject({ line_count: 2, rejected_lines: 1, value: 640 });

    const wb = await download(WIDE, "grn_register", RECENT());
    const lines = sheetRows(wb.getWorksheet("GRN Lines"), "GRN Number").filter((r) => r["GRN Number"] === W.grn.X2);
    expect(lines.map((r) => [r.Received, r.Accepted, r.Rejected, r["Rejection Reason"]])).toEqual(
      expect.arrayContaining([[40, 40, 0, null], [10, 8, 2, "Damaged"]])
    );
  });

  it("pending_deliveries returns expected rows for seeded movements", async () => {
    const rows = await rowsOf(WIDE, "pending_deliveries");
    expect(rows.map((r) => [r.po_number, r.phase, r.item_name !== null, r.due_status, r.days_overdue, r.open_qty])).toEqual([
      [W.po.X, 2, true, "Overdue", 5, 2],
      [W.po.Y, 2, true, "Overdue", 2, 10],
      [W.po.Z, 1, true, "Upcoming", null, 10],
      [W.po.U, 1, true, "Unscheduled", null, 5],
    ]);
    expect(rows[0]).toMatchObject({ vendor_name: W.vendorName, hotel_name: W.hotelName[A1], planned_qty: 10, received_qty: 8 });
    // The legacy order is overdue but excluded.
    expect(rows.some((r) => r.po_number === W.po.L)).toBe(false);
  });

  it("vendor_delivery_performance returns expected rows for seeded movements", async () => {
    const period = { from: addDays(T, -60), to: addDays(T, 30) };
    const rows = await rowsOf(WIDE, "vendor_delivery_performance", period);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vendor_name: W.vendorName, deliveries: 5, buyer_closed: 1, on_time: 3, in_full: 2, otif: 2,
    });
    expect(rows[0].otif_pct).toBeCloseTo(0.4, 6);
  });

  it("OTIF counts late and short deliveries correctly", async () => {
    const period = { from: addDays(T, -60), to: addDays(T, 30) };
    const [v] = await rowsOf(WIDE, "vendor_delivery_performance", period);
    expect(v.on_time_pct).toBeCloseTo(3 / 5, 6);
    expect(v.in_full_pct).toBeCloseTo(2 / 5, 6);

    const wb = await download(WIDE, "vendor_delivery_performance", period);
    const d = sheetRows(wb.getWorksheet("Deliveries"), "PO Number");
    const row = (po, phase) => d.find((r) => r["PO Number"] === po && r.Phase === phase);
    expect(d).toHaveLength(6);
    // early and in full
    expect(row(W.po.X, 1)).toMatchObject({ "On Time": "Yes", "In Full": "Yes", OTIF: "Yes", "Days Late": 0 });
    // received 2 days late, 2 of 10 rejected
    expect(row(W.po.X, 2)).toMatchObject({ "On Time": "No", "In Full": "No", OTIF: "No", "Days Late": 2 });
    // on its due date, then short-closed by the vendor: on time, never in full
    expect(row(W.po.Y, 1)).toMatchObject({ "On Time": "Yes", "In Full": "No", OTIF: "No", "Days Late": 0 });
    // due 2 days ago, nothing received
    expect(row(W.po.Y, 2)).toMatchObject({ "On Time": "No", "In Full": "No", OTIF: "No", "Days Late": 2 });
    expect(row(W.po.A2, 1)).toMatchObject({ OTIF: "Yes" });
    // Not yet due, unscheduled and legacy rows are not judged.
    expect(d.some((r) => [W.po.Z, W.po.U, W.po.L].includes(r["PO Number"]))).toBe(false);
  });

  it("OTIF does not count a buyer's short-close against the vendor", async () => {
    // B5's reasons, each attributed once; credit returns are vendor-side in SQL.
    expect(Object.keys(SHORT_CLOSE_ATTRIBUTION).sort()).toEqual([...SHORT_CLOSE_REASONS].sort());
    expect([...VENDOR_SHORT_CLOSE_REASONS].sort()).toEqual(["price_dispute", "vendor_cannot_supply"]);
    expect(new Set(Object.values(SHORT_CLOSE_ATTRIBUTION))).toEqual(new Set(["vendor", "buyer"]));

    const period = { from: addDays(T, -60), to: addDays(T, 30) };
    const wb = await download(WIDE, "vendor_delivery_performance", period);
    const d = sheetRows(wb.getWorksheet("Deliveries"), "PO Number");
    const row = (po, phase) => d.find((r) => r["PO Number"] === po && r.Phase === phase);
    // PO-N: 12 of 20 early, the vendor's close reopened, the buyer closed 8.
    // Excluded, not failed; only the close in force counts, and it is the buyer's.
    expect(row(W.po.N, 1)).toMatchObject({
      Assessed: "No — buyer short-close", "On Time": "—", "In Full": "—", OTIF: "—",
      "Planned (₹)": 300, "Received (₹)": 180, "Vendor Short-close (₹)": 0, "Buyer Short-close (₹)": 120,
    });
    // PO-Y phase 1: the vendor could not supply 10 of 30.
    expect(row(W.po.Y, 1)).toMatchObject({
      Assessed: "Yes", "Planned (₹)": 600, "Vendor Short-close (₹)": 200, "Buyer Short-close (₹)": 0,
    });

    const [v] = await rowsOf(WIDE, "vendor_delivery_performance", period);
    expect(v).toMatchObject({ deliveries: 5, buyer_closed: 1, otif: 2 });
  });

  it("OTIF rates are weighted by value, so units do not mix", async () => {
    const period = { from: addDays(T, -60), to: addDays(T, 30) };
    const [v] = await rowsOf(WIDE, "vendor_delivery_performance", period);
    // Rejected ÷ received, at each PO line's rate, over every row in scope:
    // 2 ltr vinegar @30 = 60 of X1 900 + X2 700 + Y1 400 + Y2 0 + A2 1000 + N 180.
    expect(v.rejection_pct).toBeCloseTo(60 / 3180, 6);
    // Vendor short-close ÷ (planned − buyer short-close):
    // flour 10 @20 = 200 of (900 + 700 + 600 + 200 + 1000 + 300) − 120.
    expect(v.short_close_pct).toBeCloseTo(200 / 3580, 6);

    const wb = await download(WIDE, "vendor_delivery_performance", period);
    const d = sheetRows(wb.getWorksheet("Deliveries"), "PO Number");
    const x2 = d.find((r) => r["PO Number"] === W.po.X && r.Phase === 2);
    // sugar 40 kg @10 + vinegar 10 ltr @30, never "50" of nothing in particular
    expect(x2).toMatchObject({ "Planned (₹)": 700, "Received (₹)": 700, "Rejected (₹)": 60, "Net Accepted (₹)": 640 });
  });
});

describe("custom period", () => {
  it("a custom range includes its end date, and a single day is a range", () => {
    expect(resolvePeriod({ from: "2026-10-01", to: "2026-10-25" })).toEqual({
      label: "2026-10-01 to 2026-10-25",
      from: "2026-10-01",
      to: "2026-10-26", // exclusive, internally
      priorLabel: "2026-09-06 to 2026-09-30",
      priorFrom: "2026-09-06",
      priorTo: "2026-10-01",
    });
    expect(resolvePeriod({ from: "2026-10-25", to: "2026-10-25" })).toEqual({
      label: "2026-10-25 to 2026-10-25",
      from: "2026-10-25",
      to: "2026-10-26",
      priorLabel: "2026-10-24 to 2026-10-24",
      priorFrom: "2026-10-24",
      priorTo: "2026-10-25",
    });
    // A month boundary and a leap day.
    expect(resolvePeriod({ from: "2028-02-29", to: "2028-02-29" })).toMatchObject({ to: "2028-03-01" });
    // Backwards or impossible dates fall back to the financial year.
    expect(resolvePeriod({ from: "2026-10-25", to: "2026-10-24", fy: "2026-27" }).label).toBe("2026-27");
    expect(resolvePeriod({ from: "2026-02-30", to: "2026-03-02", fy: "2026-27" }).label).toBe("2026-27");
  });

  it("picking today as the end date includes today's movements", async () => {
    const res = await preview(WIDE, "grn_register", { from: addDays(T, -3), to: T });
    expect(res.status).toBe(200);
    expect(res.body.data.period.label).toBe(`${addDays(T, -3)} to ${T}`);
    expect(res.body.data.rows.map((r) => r.grn_number)).toEqual([W.grn.X2, W.grn.G1, W.grn.G2]);
  });

  it("a single-day range reports that day, not the financial year", async () => {
    const res = await preview(WIDE, "stock_ledger", { from: T, to: T });
    expect(res.status).toBe(200);
    expect(res.body.data.period.label).toBe(`${T} to ${T}`);
    const { rows } = res.body.data;
    expect(rows.some((r) => r.doc_number === W.grn.G1)).toBe(true);
    // Movements posted on other days (the matches ten days ago) are outside it.
    expect(rows.some((r) => r.item_code === "D4-MATCHES")).toBe(false);

    const oneDay = await rowsOf(WIDE, "grn_register", { from: addDays(T, -3), to: addDays(T, -3) });
    expect(oneDay.map((r) => r.grn_number)).toEqual([W.grn.X2]);
  });

  it("the ledger names the GRN reversal reason in words", () => {
    expect(LEDGER_REASON_LABELS.GRN_REVERSAL).toBe("GRN reversed");
    expect(LEDGER_REASON_LABELS.WASTAGE).toBe("Wastage");
  });
});

describe("hotel scope", () => {
  it("a user scoped to hotel A1 never sees A2's rows in any report", async () => {
    const wide = { from: addDays(T, -300), to: addDays(T, 30) };
    const foreign = [W.hotelName[A2], W.hotelName[B1]];
    for (const key of INVENTORY_KEYS) {
      const res = await preview(NARROW, key, wide);
      expect(res.status).toBe(200);
      const { rows, total_rows: total } = res.body.data;
      expect({ key, total: total > 0 }).toEqual({ key, total: true });
      const text = JSON.stringify(rows);
      for (const name of foreign) expect({ key, leaks: text.includes(name) }).toEqual({ key, leaks: false });

      // Naming a hotel outside the caller's scope narrows to nothing.
      const narrowed = await preview(NARROW, key, { ...wide, hotel_ids: [A2] });
      expect(narrowed.status).toBe(200);
      expect({ key, total: narrowed.body.data.total_rows }).toEqual({ key, total: 0 });
    }

    // Aggregates without a hotel column are A1-only too.
    const consumption = await rowsOf(NARROW, "consumption_by_department", RECENT());
    const fbRice = consumption.find((r) => r.department_name === W.deptName[FB] && r.category === W.cat.rice);
    expect(fbRice.net_value).toBe(1250);
    const [otif] = await rowsOf(NARROW, "vendor_delivery_performance", { from: addDays(T, -60), to: addDays(T, 30) });
    expect(otif).toMatchObject({ deliveries: 4, buyer_closed: 1, on_time: 2, in_full: 1, otif: 1 });
  });

  it("every inventory report downloads as a workbook", async () => {
    for (const key of INVENTORY_KEYS) {
      const wb = await download(WIDE, key, RECENT());
      expect({ key, sheets: wb.worksheets.length > 0 }).toEqual({ key, sheets: true });
    }
  });
});

describe("registry", () => {
  it("registers each inventory report with its own permission", () => {
    const defs = allReports().filter((d) => INVENTORY_KEYS.includes(d.key));
    expect(defs).toHaveLength(10);
    for (const d of defs) expect(d.permission).toBe(`reports.${d.key}`);
  });
});
