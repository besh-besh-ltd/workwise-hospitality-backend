// Inventory foundation schema (Task A1): the six 20261024100x00 migrations.
// ----------------------------------------------------------------------------
// These assert what the migrations leave behind, not any service: the ledger's
// append-only guarantee, the permission/role seed, the day-one receiving grant
// for PO initiators, the legacy receipt backfill and the balance key. Every
// later inventory task builds on these, so a regression here is a regression
// everywhere.
//
// Everything runs inside withTx (always rolled back). Statements that are
// EXPECTED to fail run in a nested t.tx(), which pg-promise turns into a
// SAVEPOINT, so the failure does not poison the outer test transaction.

import { describe, it, expect, afterAll } from "@jest/globals";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL_FILE = path.resolve(
  __dirname,
  "../../migrations/20261024100500_po_receipt_backfill.sql"
);

const INVENTORY_PERMISSIONS = [
  "grn.approve",
  "grn.create",
  "grn.read",
  "grn.update",
  "inventory.admin",
  "inventory.approve",
  "inventory.create",
  "inventory.read",
  "inventory.update",
];

const INVENTORY_REPORT_KEYS = [
  "reports.consumption_by_department",
  "reports.count_variance",
  "reports.grn_register",
  "reports.near_expiry",
  "reports.pending_deliveries",
  "reports.slow_moving",
  "reports.stock_adjustments",
  "reports.stock_ledger",
  "reports.stock_on_hand",
  "reports.vendor_delivery_performance",
];

afterAll(async () => {
  await closeDb();
});

/** The statements between `-- backfill` and `-- end backfill` in the migration. */
function backfillBlock() {
  const sql = fs.readFileSync(BACKFILL_FILE, "utf8");
  const m = sql.match(/^-- backfill[ \t]*$([\s\S]*?)^-- end backfill[ \t]*$/m);
  if (!m) throw new Error(`no '-- backfill' … '-- end backfill' block in ${BACKFILL_FILE}`);
  return m[1];
}

/** Permission strings held by the single SYSTEM role with this title. */
async function systemRolePermissions(conn, title) {
  const roles = await conn.any(
    `SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`,
    [title]
  );
  expect(roles).toHaveLength(1);
  const rows = await conn.any(
    `SELECT p.resource::text || '.' || p.action::text AS perm
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1`,
    [roles[0].id]
  );
  return rows.map((r) => r.perm).sort();
}

async function makeItem(t, companyId = IDS.hospitality.A) {
  return t.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom)
     VALUES ($1, 'Schema test soap', 'pcs') RETURNING id`,
    [companyId]
  );
}

// A non-call-off PO must carry an rfq_id (tbl_rfq_purchase_order_call_off_or_rfq_chk).
async function makePo(t, status) {
  const { rfq_id } = await makeRFQ(t, { createdBy: IDS.users.a1_proc_buyer, status: 1, is_published: 1 });
  return t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}')
     RETURNING id`,
    [rfq_id, IDS.companies.A, `INV-SCHEMA-${status}-${rfq_id}`, status, IDS.users.vendor_alpha]
  );
}

describe("inventory ledger", () => {
  it("ledger rows are append-only", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      const mv = await t.one(
        `INSERT INTO tbl_inv_movement
           (hospitality_company_id, hotel_id, inv_item_id, movement_type, qty,
            unit_cost, value, qty_after, avg_cost_after, source_type, source_id)
         VALUES ($1, $2, $3, 'GRN_IN', 10, 5, 50, 10, 5, 'TEST', 1)
         RETURNING id`,
        [IDS.hospitality.A, IDS.hotels.A1, item.id]
      );

      await expect(
        t.tx((sp) => sp.none(`UPDATE tbl_inv_movement SET qty = 11 WHERE id = $1`, [mv.id]))
      ).rejects.toThrow(/append-only/);
      await expect(
        t.tx((sp) => sp.none(`DELETE FROM tbl_inv_movement WHERE id = $1`, [mv.id]))
      ).rejects.toThrow(/append-only/);

      const still = await t.one(`SELECT qty::text AS qty FROM tbl_inv_movement WHERE id = $1`, [mv.id]);
      expect(Number(still.qty)).toBe(10);
    });
  });

  it("balance PK is (hotel_id, inv_item_id)", async () => {
    await withTx(async (t) => {
      const item = await makeItem(t);
      const insert = (conn) =>
        conn.none(
          `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id, qty, avg_cost, value)
           VALUES ($1, $2, $3, 1, 1, 1)`,
          [IDS.hotels.A1, item.id, IDS.hospitality.A]
        );
      await insert(t);
      await expect(t.tx((sp) => insert(sp))).rejects.toThrow(/duplicate key/);

      // A different hotel for the same item is a different balance row.
      await t.none(
        `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id)
         VALUES ($1, $2, $3)`,
        [IDS.hotels.A2, item.id, IDS.hospitality.A]
      );
    });
  });
});

describe("inventory permissions and roles", () => {
  it("inventory permissions and roles are seeded", async () => {
    const perms = await db.any(
      `SELECT resource::text || '.' || action::text AS perm
         FROM tbl_permissions
        WHERE resource::text IN ('grn', 'inventory')`
    );
    expect(perms.map((p) => p.perm).sort()).toEqual(INVENTORY_PERMISSIONS);

    const reports = await db.any(
      `SELECT resource::text || '.' || action::text AS perm
         FROM tbl_permissions
        WHERE resource::text = 'reports' AND action::text = ANY($1::text[])`,
      [INVENTORY_REPORT_KEYS.map((k) => k.split(".")[1])]
    );
    expect(reports.map((p) => p.perm).sort()).toEqual(INVENTORY_REPORT_KEYS);

    expect(await systemRolePermissions(db, "Storekeeper")).toEqual([
      "grn.create",
      "grn.read",
      "grn.update",
      "inventory.create",
      "inventory.read",
      "inventory.update",
    ]);

    const controller = await systemRolePermissions(db, "Inventory Controller");
    expect(controller).toEqual(expect.arrayContaining(["inventory.approve", "inventory.admin"]));
    expect(controller).toEqual([...INVENTORY_PERMISSIONS, ...INVENTORY_REPORT_KEYS].sort());

    const admin = await systemRolePermissions(db, "Company Administrator");
    expect(admin).toEqual(
      expect.arrayContaining(["inventory.read", "inventory.admin", "grn.read", ...INVENTORY_REPORT_KEYS])
    );
  });

  it("PO initiator roles can receive", async () => {
    const initiators = await db.any(
      `SELECT DISTINCT r.id, r.created_by
         FROM tbl_roles r
         JOIN tbl_role_permissions rp ON rp.role_id = r.id
         JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE p.resource::text = 'awarding' AND p.action::text = 'create'`
    );
    // Sanity: the seed has awarding.create holders, system AND company-created.
    expect(initiators.length).toBeGreaterThan(0);
    expect(initiators.some((r) => r.created_by != null)).toBe(true);

    const missing = await db.any(
      `SELECT r.id, need.action
         FROM tbl_roles r
         CROSS JOIN (VALUES ('read'), ('create')) AS need(action)
        WHERE r.id = ANY($1::int[])
          AND NOT EXISTS (
            SELECT 1 FROM tbl_role_permissions rp
              JOIN tbl_permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = r.id
               AND p.resource::text = 'grn'
               AND p.action::text = need.action)`,
      [initiators.map((r) => r.id)]
    );
    expect(missing).toEqual([]);
  });
});

describe("legacy receipt backfill", () => {
  it("legacy received POs are flagged", async () => {
    await withTx(async (t) => {
      const received = await makePo(t, "GRN");
      const backlog = await makePo(t, "approved");
      const planned = await makePo(t, "GRN");
      await t.none(
        `UPDATE tbl_rfq_purchase_order
            SET receipt_status = 'not_received', receipt_legacy = false
          WHERE id = ANY($1::int[])`,
        [[received.id, backlog.id, planned.id]]
      );
      // A PO that already has a delivery plan was received through the new
      // flow: a re-run of the backfill must never relabel it as legacy.
      await t.none(
        `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no)
         VALUES ($1, $2, $3, 1)`,
        [IDS.hospitality.A, planned.id, IDS.hotels.A1]
      );

      await t.none(backfillBlock());

      const rows = await t.any(
        `SELECT id, receipt_status, receipt_legacy
           FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`,
        [[received.id, backlog.id, planned.id]]
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[received.id]).toMatchObject({ receipt_status: "received", receipt_legacy: true });
      expect(byId[backlog.id]).toMatchObject({ receipt_status: "not_received", receipt_legacy: true });
      expect(byId[planned.id]).toMatchObject({ receipt_status: "not_received", receipt_legacy: false });

      // The backfill creates no plan rows.
      const plans = await t.one(
        `SELECT count(*)::int AS n FROM tbl_po_delivery WHERE po_id = ANY($1::int[])`,
        [[received.id, backlog.id]]
      );
      expect(plans.n).toBe(0);
    });
  });
});
