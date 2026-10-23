// Schema contract for PO send-backs (hold / info request / re-award / cancel),
// the re-award trace and the one-time initiate reminder.
import { describe, it, expect, afterAll } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ, makePendingApproval } from "../factories/rfq.js";

afterAll(closeDb);

const BUYER = IDS.users.a1_proc_buyer;
const OTHER = IDS.users.companyA_admin;

// Each violation runs in its own savepoint so the outer transaction survives.
const rejects = (t, sql, params, re) =>
  expect(t.tx((s) => s.none(sql, params))).rejects.toThrow(re);

async function world(t) {
  const { rfq_id } = await makeRFQ(t, { createdBy: BUYER });
  const inst = await makePendingApproval(t, {
    entity_type: "PO",
    entity_id: 0,
    policy_id: IDS.policies.A1_P1_RFQ,
    initiated_by: BUYER,
    hospitality: IDS.hospitality.A,
  });
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, total_value, initiated_by, finalized_vendor_id)
     VALUES ($1, $2, 'PO-SB-' || $1, 'pending_approval', '{}', 1, 100, 1000, $3, $4)
     RETURNING id`,
    [rfq_id, IDS.companies.A, BUYER, IDS.users.vendor_alpha]
  );
  return { rfq_id, inst, po_id: po.id };
}

const INSERT_SB = `
  INSERT INTO tbl_po_send_backs
    (purchase_order_id, rfq_id, approval_instance_id, step_order, route,
     reason_category, comment, requested_by, target_role, target_user_id)
  VALUES ($1, $2, $3, 1, $4, $5, 'why', $6, $7, $8)
  RETURNING id`;

describe("PO send-back schema", () => {
  it("allows only one OPEN hold per PO", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      const args = [w.po_id, w.rfq_id, w.inst.id, "INFO_REQUEST", "INFO_MISSING", BUYER, "RFQ_CREATOR", OTHER];
      await t.one(INSERT_SB, args);
      await rejects(t, INSERT_SB, args, /ux_po_send_back_one_open|unique/i);
      // once the first is no longer OPEN a new hold is allowed
      await t.none(`UPDATE tbl_po_send_backs SET status='ANSWERED' WHERE purchase_order_id=$1`, [w.po_id]);
      await t.one(INSERT_SB, args);
    });
  });

  it("an INFO_REQUEST needs a target", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      await rejects(
        t, INSERT_SB,
        [w.po_id, w.rfq_id, w.inst.id, "INFO_REQUEST", "INFO_MISSING", BUYER, null, null],
        /check/i
      );
      // COMMERCIAL / CANCEL need no target
      await t.one(INSERT_SB, [w.po_id, w.rfq_id, w.inst.id, "COMMERCIAL", "RENEGOTIATE", BUYER, null, null]);
    });
  });

  it("accepts the reserved TECHNICAL route at the schema level", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      const row = await t.one(INSERT_SB, [
        w.po_id, w.rfq_id, w.inst.id, "TECHNICAL", "TECH_QUERY", BUYER, "TECHNICAL_EVALUATOR", OTHER,
      ]);
      expect(row.id).toBeGreaterThan(0);
      await rejects(
        t, INSERT_SB.replace("RETURNING id", "RETURNING id"),
        [w.po_id, w.rfq_id, w.inst.id, "BOGUS", "OTHER", BUYER, null, null],
        /check/i
      );
    });
  });

  it("keeps every existing approval action valid and accepts SEND_BACK", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      const actions = [
        "APPROVE", "REJECT", "CANCELLED", "POLICY_CHANGE", "APPROVER_REMOVED",
        "APPROVER_ADDED", "STEP_REMOVED", "STEP_ADDED", "MEMBERSHIP_REVALIDATION",
        "SEND_BACK", "SEND_BACK_ANSWERED", "SEND_BACK_WITHDRAWN",
      ];
      // The CHECK lists every value. (MEMBERSHIP_REVALIDATION is 23 chars and the
      // column is varchar(20) -- a pre-existing width bug, so it cannot be
      // inserted; assert it via the constraint definition instead.)
      const def = await t.one(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
          WHERE conname='tbl_approval_actions_action_check'`
      );
      for (const a of actions) expect(def.d).toContain(`'${a}'`);
      for (const a of actions.filter((x) => x.length <= 20)) {
        await t.none(
          `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action)
           VALUES ($1, $2, $3)`,
          [w.inst.id, BUYER, a]
        );
      }
      await rejects(
        t,
        `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action)
         VALUES ($1, $2, 'NOPE')`,
        [w.inst.id, BUYER], /check/i
      );
    });
  });

  it("adds the re-award trace and the initiate reminder columns, and a files table", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      const cols = await t.map(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='tbl_rfq_purchase_order'
            AND column_name IN ('replaces_po_id','initiate_reminded_at')`,
        [], (r) => r.column_name
      );
      expect(cols.sort()).toEqual(["initiate_reminded_at", "replaces_po_id"]);
      const sb = await t.one(INSERT_SB, [w.po_id, w.rfq_id, w.inst.id, "CANCEL", "NOT_REQUIRED", BUYER, null, null]);
      await t.none(
        `INSERT INTO tbl_po_send_back_files (send_back_id, side, file_url, uploaded_by)
         VALUES ($1, 'REQUEST', 'https://x/y.pdf', $2)`, [sb.id, BUYER]
      );
      await rejects(
        t,
        `INSERT INTO tbl_po_send_back_files (send_back_id, side, file_url, uploaded_by)
         VALUES ($1, 'NOPE', 'u', $2)`, [sb.id, BUYER], /check/i
      );
    });
  });

  it("records audit rows for send-back changes", async () => {
    await withTx(async (t) => {
      const w = await world(t);
      const sb = await t.one(INSERT_SB, [w.po_id, w.rfq_id, w.inst.id, "CANCEL", "NOT_REQUIRED", BUYER, null, null]);
      await t.none(`UPDATE tbl_po_send_backs SET status='WITHDRAWN', closed_at=now() WHERE id=$1`, [sb.id]);
      const rows = await t.any(
        `SELECT operation FROM tbl_audit_row_changes
          WHERE table_name='tbl_po_send_backs' AND record_id=$1`, [sb.id]
      );
      expect(rows.map((r) => r.operation)).toContain("UPDATE");
    });
  });
});
