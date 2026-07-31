// negotiationQuote.reject.test.js — the missing NEGOTIATION_QUOTE REJECTED
// post-action handler (live data-integrity trap).
//
// THE BUG:
//   `postActionRegistry` in app/services/approvalActionService.js registers
//   NEGOTIATION_QUOTE with an APPROVED handler and NO REJECTED handler — the
//   only entity type in the registry missing its rejection pair (RFQ, PO,
//   NEGOTIATION and ARC_NEGOTIATION all have both).
//
//   The dedicated endpoint POST /negotiation/quotes/:rfq_product_id/reject does
//   the right thing inline: it resets the vendor finalization and records a
//   NEGOTIATION_QUOTES_REJECTED lifecycle event. But the *generic* endpoint
//   POST /general/hospitality/approval/action — which is what the entity-
//   agnostic RfqApprovalDecisionCard on the RFQ details page calls, and which
//   renders a Reject button for commercial-phase instances — only flipped the
//   approval instance to REJECTED. The product stayed FINALIZED to a vendor
//   whose approval had just been rejected, with nothing in the lifecycle to
//   show for it.
//
// THE FIX: one shared rejection handler, invoked from exactly one place per
// request. The dedicated endpoint now routes through `executeApprovalAction`,
// so both surfaces converge on the registry entry — no inline duplicate, so no
// possibility of the side effects running twice.
//
// These tests assert OBSERVABLE OUTCOMES only (finalization rows, history rows,
// lifecycle rows) — never which function called which.

import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const APPROVER = IDS.users.a1_proc_commApp; // sole approver on A1/P1 NEGOTIATION_QUOTE
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VARIANT_ID = 1;

let RFQ_NO = 8_770_000;
const nextRfqNo = () => ++RFQ_NO;

let approverClient;
const created = { rfqIds: [], instanceIds: [] };

/**
 * Seed the exact live state the trap needs: a product finalized to a vendor,
 * with a PENDING NEGOTIATION_QUOTE approval instance sitting on that award.
 */
async function seedFinalizedAwaitingApproval(label) {
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString().replace("T", " ").slice(0, 19);

  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '<p>e2e</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3, NOW(),
             $4, $5, $6, 0, $7)
     RETURNING id, rfq_no`,
    [nextRfqNo(), oneDayAgo, BUYER, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, label]
  );
  created.rfqIds.push(Number(rfq.id));

  const rfqProd = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
    [rfq.id, VARIANT_ID]
  );

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq.id, VARIANT_ID, VENDOR]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
    [rfq.id, rfq.rfq_no, VENDOR]
  );

  await db.none(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, variant, comment, delivery_period, quantity, tax_mode)
     VALUES ($1, $2, $3, $4, 500, 25000, 0, 18, 0, 0, 'seed', '15', '50', 'percentage')`,
    [rfq.id, rfq.rfq_no, quote.id, VARIANT_ID]
  );

  // The award itself — this row is what must not survive a rejection.
  await db.none(
    `INSERT INTO tbl_quote_finalization
       (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, "timestamp")
     VALUES ($1, $2, $3, $4, $5, $6, 0, NOW())`,
    [rfq.id, rfq.rfq_no, VARIANT_ID, VENDOR, quote.id, BUYER]
  );

  const { instance, autoApproved } = await createApprovalInstance({
    entity_type: "NEGOTIATION_QUOTE",
    entity_id: rfqProd.id,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: null,
    process_id: IDS.processes.A_P1,
    initiated_by: BUYER,
    metadata: {
      rfq_id: Number(rfq.id),
      rfq_number: Number(rfq.rfq_no),
      rfq_product_id: Number(rfqProd.id),
      is_tender: 0,
      product_variant_id: VARIANT_ID,
      variant: 0,
      vendor_id: VENDOR,
      quote_id: Number(quote.id),
      selected_quotes: [
        { vendor_id: VENDOR, quote_id: Number(quote.id), quoted_price: 480 },
      ],
    },
  });
  created.instanceIds.push(Number(instance.id));

  // The buyer initiated and the approver is someone else, so nothing auto-approves.
  expect(autoApproved).toBeFalsy();
  expect(instance.status).toBe("PENDING");

  return {
    rfqId: Number(rfq.id),
    rfqNo: Number(rfq.rfq_no),
    rfqProductId: Number(rfqProd.id),
    quoteId: Number(quote.id),
    instanceId: Number(instance.id),
  };
}

const finalizationRows = (rfqId) =>
  db.any(`SELECT * FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfqId]);

const finalizationHistoryRows = (rfqId) =>
  db.any(`SELECT * FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [rfqId]);

const rejectionLifecycleRows = (rfqId) =>
  db.any(
    `SELECT * FROM tbl_lifecycle_history
      WHERE entity_id = $1 AND stage = 'NEGOTIATION_QUOTES_REJECTED'`,
    [rfqId]
  );

const instanceStatus = async (instanceId) =>
  (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [instanceId])).status;

describe("NEGOTIATION_QUOTE rejection — generic approval endpoint must reset the award", () => {
  beforeAll(async () => {
    // The dedicated negotiation route is gated by acl([2, 8]); fixture users
    // carry a NULL user_type by design. Restored in afterAll.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [APPROVER]);
    approverClient = await httpClient(APPROVER);
  });

  afterAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [APPROVER]);
  });

  afterEach(async () => {
    if (created.instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [created.instanceIds]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers
          WHERE approval_instance_step_id IN
            (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
        [created.instanceIds]
      );
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [created.instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [created.instanceIds]);
      created.instanceIds = [];
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
      created.rfqIds = [];
    }
  });

  // ── THE TRAP: rejecting through the entity-agnostic surface ──────────────
  test("POST /general/hospitality/approval/action REJECT resets the finalization and records the lifecycle event", async () => {
    const seed = await seedFinalizedAwaitingApproval("generic-endpoint rejection");

    expect(await finalizationRows(seed.rfqId)).toHaveLength(1);

    const res = await approverClient
      .post("/api/v1/general/hospitality/approval/action")
      .send({
        approval_instance_id: seed.instanceId,
        action: "REJECT",
        comment: "Price still above budget",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.instance_status).toBe("REJECTED");
    expect(await instanceStatus(seed.instanceId)).toBe("REJECTED");

    // The award must be gone — not merely flagged.
    expect(await finalizationRows(seed.rfqId)).toHaveLength(0);

    // …and archived, so the reversal is auditable.
    const history = await finalizationHistoryRows(seed.rfqId);
    expect(history).toHaveLength(1);
    expect(Number(history[0].vendor_id)).toBe(VENDOR);
    expect(Number(history[0].changed_by)).toBe(APPROVER);

    // …with the rejection visible on the RFQ timeline, exactly once.
    const lifecycle = await rejectionLifecycleRows(seed.rfqId);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].entity_type).toBe("RFQ");
    expect(lifecycle[0].action).toBe("REJECT");
    expect(Number(lifecycle[0].performed_by)).toBe(APPROVER);
    expect(lifecycle[0].remarks).toBe("Price still above budget");
  });

  // ── PARITY + no double execution on the dedicated endpoint ───────────────
  test("POST /negotiation/quotes/:rfq_product_id/reject produces the identical outcome, with the side effects applied exactly once", async () => {
    const seed = await seedFinalizedAwaitingApproval("dedicated-endpoint rejection");

    expect(await finalizationRows(seed.rfqId)).toHaveLength(1);

    const res = await approverClient
      .post(`/api/v1/negotiation/quotes/${seed.rfqProductId}/reject`)
      .send({ remarks: "Price still above budget" });

    expect(res.status).toBe(200);
    expect(res.body.data.rejected).toBe(true);
    expect(await instanceStatus(seed.instanceId)).toBe("REJECTED");

    expect(await finalizationRows(seed.rfqId)).toHaveLength(0);

    // Exactly one of each — a second (duplicated) invocation of the shared
    // handler would archive twice / log the event twice.
    const history = await finalizationHistoryRows(seed.rfqId);
    expect(history).toHaveLength(1);
    expect(Number(history[0].vendor_id)).toBe(VENDOR);

    const lifecycle = await rejectionLifecycleRows(seed.rfqId);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].entity_type).toBe("RFQ");
    expect(lifecycle[0].action).toBe("REJECT");
    expect(Number(lifecycle[0].performed_by)).toBe(APPROVER);
    expect(lifecycle[0].remarks).toBe("Price still above budget");
  });

  // ── Guard: the handler must not fire on an instance that wasn't rejected ──
  test("an APPROVE through the generic endpoint leaves the finalization intact", async () => {
    const seed = await seedFinalizedAwaitingApproval("generic-endpoint approval control");

    const res = await approverClient
      .post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: seed.instanceId, action: "APPROVE", comment: "ok" });

    expect(res.status).toBe(200);
    expect(res.body.data.instance_status).toBe("APPROVED");

    // The award survives, and no rejection is written to the timeline.
    expect(await finalizationRows(seed.rfqId)).toHaveLength(1);
    expect(await rejectionLifecycleRows(seed.rfqId)).toHaveLength(0);

    // Clean up the PO the approval path drafts.
    const poIds = (
      await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [seed.rfqId])
    ).map((r) => Number(r.id));
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
  });
});
