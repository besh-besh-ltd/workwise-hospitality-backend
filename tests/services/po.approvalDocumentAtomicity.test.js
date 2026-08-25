// An approval and its document commit together, or neither happens.
//
// This is the guarantee the client asked for after production kept recording
// approvals whose PO document never got rewritten. Sixteen POs in
// hospitality_main carry a document written before their own final approval;
// on 2026-08-24 one approver hit Approve four times on PO 501 because nothing
// appeared to happen, and all four attempts left the same stale document.
//
// It could not have worked before, for a structural reason worth stating.
// The dedicated endpoint looked atomic:
//
//     await db.tx(async t => {
//        await submitApprovalAction({ ... })      // <-- no `t`
//        await regeneratePODocument(po_id, t)
//        await handlePOPostApproval(..., { txContext: t })
//     })
//
// but `submitApprovalAction` opened its OWN `db.tx` on a second connection and
// committed independently. By the time the document was attempted, the
// approval was already durable — rolling the outer transaction back could not
// undo it. The split ran the other way too: if the post-action threw, the
// outer transaction rolled back the PO status transition while the approval
// stayed APPROVED.
//
// So atomicity needs the approval write and the document write on ONE
// connection in ONE transaction. These tests pin that.
//
// Note the ordering that makes this possible: the document is built through
// the same transaction that just recorded the approval, so it reads the
// not-yet-committed approver row and prints this approver as "Approved". That
// is the whole reason the document can be part of the same commit.

import { describe, it, expect, afterAll } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { executePoApprovalAtomically } from "../../app/services/poApprovalService.js";

afterAll(async () => { await closeDb(); });

let SEQ = 7_400_000;
const next = () => ++SEQ;

// ─────────────────────────────────────────────────────────────────────────
//  Build a PO sitting on a single-step PENDING approval instance.
// ─────────────────────────────────────────────────────────────────────────
async function makePoAwaitingApproval(t, { approver = IDS.users.a1_proc_poApp, steps = 1 } = {}) {
  const rfqNo = next();
  const rfq = await t.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
                          contact_number, bid_end_date, location, is_published, status,
                          created_by, updated_by, "timestamp", hospitality_company_id,
                          hotel_id, process_id, is_tender, title)
     VALUES ($1,'','','b@t','b','0', NOW() + INTERVAL '7 days','Mumbai',1,1,$2,$2,NOW(),$3,$4,$5,0,$6)
     RETURNING id`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, `Atomicity RFQ ${rfqNo}`]
  );

  const policy = await t.one(
    `INSERT INTO tbl_approval_policies (entity_type, hospitality_company_id, hotel_id, is_active, created_by)
     VALUES ('PO',$1,$2,true,$3) RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );

  const instance = await t.one(
    `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status,
                                         current_step, hospitality_company_id, hotel_id,
                                         initiated_by, metadata)
     VALUES ('PO', 0, $1, 'PENDING', 1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [policy.id, IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );

  for (let order = 1; order <= steps; order++) {
    const step = await t.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1,$2,'ANY','PENDING') RETURNING id`,
      [instance.id, order]
    );
    await t.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
       VALUES ($1,$2,'PENDING')`,
      [step.id, approver]
    );
  }

  const product = await t.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );

  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order (rfq_id, rfq_product_id, po_number, company_id, status,
                                         quantity, unit_price, finalized_vendor_id, total_value,
                                         approval_instance_id, po_pdf_url, created_at)
     VALUES ($1,ARRAY[$2::int],$3,$4,'pending_approval',10,100,$5,1000,$6,$7,NOW())
     RETURNING id, po_pdf_url`,
    [rfq.id, product.id, String(next()), IDS.companies.A, IDS.users.vendor_alpha, instance.id, STALE_URL]
  );

  await t.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po.id, instance.id]);

  return { poId: po.id, instanceId: instance.id, rfqId: rfq.id };
}

const STALE_URL = "https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-OLD-1750000000000.pdf";
const FRESH_URL = "https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-NEW-1756000000000.pdf";

const approvalState = (t, instanceId) =>
  t.one(
    `SELECT ai.status AS instance_status,
            (SELECT COUNT(*) FROM tbl_approval_step_approvers sa
               JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
              WHERE s.approval_instance_id = ai.id AND sa.status = 'APPROVED')::int AS approved_count,
            (SELECT COUNT(*) FROM tbl_approval_actions WHERE approval_instance_id = ai.id)::int AS action_count
       FROM tbl_approval_instances ai WHERE ai.id = $1`,
    [instanceId]
  );

const poUrl = (t, poId) =>
  t.one(`SELECT po_pdf_url, status FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);

// A document writer that succeeds, recording the connection it was handed.
const workingWriter = (seen = []) => async (poId, conn) => {
  seen.push(conn);
  await conn.none(
    `UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1, updated_at = NOW() WHERE id = $2`,
    [FRESH_URL, poId]
  );
  return FRESH_URL;
};

const failingWriter = (message = "Failed to launch the browser process") => async () => {
  throw new Error(message);
};

describe("PO approval and document atomicity", () => {
  it("commits the approval and the document together", async () => {
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);

      await executePoApprovalAtomically(
        { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
        { conn: t, writeDocument: workingWriter() }
      );

      expect((await approvalState(t, instanceId)).instance_status).toBe("APPROVED");
      expect((await poUrl(t, poId)).po_pdf_url).toBe(FRESH_URL);
    });
  });

  it("rolls the approval back when the document cannot be generated", async () => {
    // The production failure, made loud: Chromium would not start.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);

      await expect(
        executePoApprovalAtomically(
          { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
          { conn: t, writeDocument: failingWriter() }
        )
      ).rejects.toThrow(/launch/i);

      const state = await approvalState(t, instanceId);
      expect(state.instance_status).toBe("PENDING");
      expect(state.approved_count).toBe(0);
    });
  });

  it("records no approval action when the document fails", async () => {
    // Nothing may survive in the audit trail either — a recorded action with
    // no approval is exactly the split-brain this replaces.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);

      await expect(
        executePoApprovalAtomically(
          { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
          { conn: t, writeDocument: failingWriter() }
        )
      ).rejects.toThrow();

      expect((await approvalState(t, instanceId)).action_count).toBe(0);
    });
  });

  it("leaves the previous document untouched when generation fails", async () => {
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);

      await expect(
        executePoApprovalAtomically(
          { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
          { conn: t, writeDocument: failingWriter() }
        )
      ).rejects.toThrow();

      expect((await poUrl(t, poId)).po_pdf_url).toBe(STALE_URL);
    });
  });

  it("lets the approver succeed on a retry after a transient failure", async () => {
    // PO 507's approver clicked four times. Once generation recovers, the
    // approval must go through cleanly rather than be permanently poisoned.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      const args = { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" };

      await expect(
        executePoApprovalAtomically(args, { conn: t, writeDocument: failingWriter() })
      ).rejects.toThrow();

      await executePoApprovalAtomically(args, { conn: t, writeDocument: workingWriter() });

      expect((await approvalState(t, instanceId)).instance_status).toBe("APPROVED");
      expect((await poUrl(t, poId)).po_pdf_url).toBe(FRESH_URL);
    });
  });

  it("builds the document on the approval's own transaction", async () => {
    // The document must see the uncommitted approver row, otherwise it prints
    // this approver as "Invited" — the original reported defect.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      const seen = [];

      await executePoApprovalAtomically(
        { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
        { conn: t, writeDocument: workingWriter(seen) }
      );

      const approvedInsideWriter = await seen[0].one(
        `SELECT COUNT(*)::int AS n FROM tbl_approval_step_approvers sa
           JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
          WHERE s.approval_instance_id = $1 AND sa.status = 'APPROVED'`,
        [instanceId]
      );
      expect(approvedInsideWriter.n).toBe(1);
    });
  });

  it("regenerates the document when an approver retries an already-recorded approval", async () => {
    // Self-heal: the approver who clicks Approve again on a PO whose document
    // went stale gets the document rewritten, without a second approval.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      const args = { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" };

      await executePoApprovalAtomically(args, { conn: t, writeDocument: workingWriter() });
      await t.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [STALE_URL, poId]);

      await executePoApprovalAtomically(args, { conn: t, writeDocument: workingWriter() });

      expect((await poUrl(t, poId)).po_pdf_url).toBe(FRESH_URL);
      expect((await approvalState(t, instanceId)).approved_count).toBe(1);
    });
  });

  it("does not generate a document when the decision is REJECT", async () => {
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      let called = false;

      await executePoApprovalAtomically(
        { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "REJECT", comment: "no" },
        { conn: t, writeDocument: async () => { called = true; } }
      );

      expect(called).toBe(false);
      expect((await approvalState(t, instanceId)).instance_status).toBe("REJECTED");
    });
  });

  it("does not run post-commit work when the document fails", async () => {
    // The vendor must not be emailed about an approval that got rolled back.
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      const afterCommit = [];

      await expect(
        executePoApprovalAtomically(
          { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
          { conn: t, writeDocument: failingWriter(), afterCommit: async () => { afterCommit.push(1); } }
        )
      ).rejects.toThrow();

      expect(afterCommit).toHaveLength(0);
    });
  });

  it("runs post-commit work once the approval has committed", async () => {
    await withTx(async (t) => {
      const { poId, instanceId } = await makePoAwaitingApproval(t);
      const afterCommit = [];

      await executePoApprovalAtomically(
        { po_id: poId, approval_instance_id: instanceId, approver_user_id: IDS.users.a1_proc_poApp, action: "APPROVE" },
        { conn: t, writeDocument: workingWriter(), afterCommit: async (r) => { afterCommit.push(r.instance_status); } }
      );

      expect(afterCommit).toEqual(["APPROVED"]);
    });
  });
});
