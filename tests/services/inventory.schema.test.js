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
const PERMISSIONS_FILE = path.resolve(
  __dirname,
  "../../migrations/20261024100400_inventory_permissions.sql"
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

/**
 * Step 4 of the permissions migration (every awarding.create holder gains
 * grn.read + grn.create), without the file's BEGIN/COMMIT.
 */
function dayOneGrantBlock() {
  const sql = fs.readFileSync(PERMISSIONS_FILE, "utf8");
  const m = sql.match(/^-- Step 4:[^\n]*\n([\s\S]*?)^COMMIT;/m);
  if (!m) throw new Error(`no '-- Step 4:' … 'COMMIT;' block in ${PERMISSIONS_FILE}`);
  return m[1];
}

/** Ids of roles holding awarding.create, narrowed by an extra predicate on r. */
async function awardingCreateHolders(conn, where, params = []) {
  const rows = await conn.any(
    `SELECT DISTINCT r.id
       FROM tbl_roles r
       JOIN tbl_role_permissions rp ON rp.role_id = r.id
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE p.resource::text = 'awarding' AND p.action::text = 'create'
        AND ${where}
      ORDER BY r.id`,
    params
  );
  return rows.map((r) => r.id);
}

/** (role, action) pairs among roleIds that lack grn.read or grn.create. */
async function rolesMissingGrnReceive(conn, roleIds) {
  return conn.any(
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
    [roleIds]
  );
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

describe("receiving indexes and keys (E1)", () => {
  it("every receiving foreign key that a delete or a lookup checks has an index", async () => {
    const rows = await db.any(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [[
        "ix_po_dispatch_line_po_line", "ix_po_dispatch_delivery", "ix_grn_dispatch", "ix_grn_received_by_token",
        "ix_purchase_order_document_dispatch", "ix_grn_line_inv_item", "ux_po_dispatch_po_client_event",
      ]]
    );
    const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/\s+/g, " ")]));
    expect(def.ix_po_dispatch_line_po_line).toMatch(/ON public\.tbl_po_dispatch_line USING btree \(po_line_id\)$/);
    expect(def.ix_po_dispatch_delivery).toMatch(/ON public\.tbl_po_dispatch USING btree \(delivery_id\) WHERE \(delivery_id IS NOT NULL\)$/);
    expect(def.ix_grn_dispatch).toMatch(/ON public\.tbl_grn USING btree \(dispatch_id\) WHERE \(dispatch_id IS NOT NULL\)$/);
    expect(def.ix_grn_received_by_token)
      .toMatch(/ON public\.tbl_grn USING btree \(received_by_token_id\) WHERE \(received_by_token_id IS NOT NULL\)$/);
    expect(def.ix_purchase_order_document_dispatch)
      .toMatch(/ON public\.tbl_purchase_order_document USING btree \(dispatch_id\) WHERE \(dispatch_id IS NOT NULL\)$/);
    expect(def.ix_grn_line_inv_item).toMatch(/ON public\.tbl_grn_line USING btree \(inv_item_id\) WHERE \(inv_item_id IS NOT NULL\)$/);
    // The vendor's create-dispatch idempotency key: unique per PO.
    expect(def.ux_po_dispatch_po_client_event)
      .toMatch(/UNIQUE INDEX .* ON public\.tbl_po_dispatch USING btree \(po_id, client_event_id\) WHERE \(client_event_id IS NOT NULL\)$/);
  });

  it("an RTV records when it was dispatched (roll-up order)", async () => {
    const col = await db.oneOrNone(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tbl_rtv' AND column_name = 'dispatched_at'`
    );
    expect(col).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
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
    // Only roles this test controls: the seed's SYSTEM roles (present when the
    // migration ran) and one company-created role made below. Company roles
    // that other suites commit later never got the one-time grant, so counting
    // them would make this test depend on suite order.
    await withTx(async (t) => {
      const systemInitiators = await awardingCreateHolders(t, "r.created_by IS NULL");
      expect(systemInitiators.length).toBeGreaterThan(0);
      expect(await rolesMissingGrnReceive(t, systemInitiators)).toEqual([]);

      // A company-created PO initiator, then the migration's day-one grant as it
      // runs on a database that holds such a role.
      const custom = await t.one(
        `INSERT INTO tbl_roles (title, description, created_by)
         VALUES ('Schema test PO initiator', 'company-created awarding.create holder', $1)
         RETURNING id`,
        [IDS.users.companyA_admin]
      );
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, id FROM tbl_permissions
          WHERE resource::text = 'awarding' AND action::text = 'create'`,
        [custom.id]
      );
      expect(await rolesMissingGrnReceive(t, [custom.id])).toHaveLength(2);

      await t.none(dayOneGrantBlock());

      expect(await awardingCreateHolders(t, "r.id = $1", [custom.id])).toEqual([custom.id]);
      expect(await rolesMissingGrnReceive(t, [custom.id])).toEqual([]);
    });
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
