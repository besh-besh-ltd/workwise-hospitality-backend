// A PO waiting on its approver, built through the real award and initiate
// flows, for the PO rejection suites (po.reject.*, rfq.lifecycle.poRejected).
//
// Who is who (all fixture users at hospitality A / hotel A1 / procurement):
//   CREATOR      a1_proc_buyer    raised the RFQ
//   COMM_EVAL    a1_proc_commEval raised the award approval (NEGOTIATION_QUOTE),
//                                 so the drafted PO's creator (initiated_by)
//   COMM_APP     a1_proc_commApp  approved the award, so it finalized the vendor
//   INITIATOR    companyA_admin   pressed Initiate (CEO, not a PO approver)
//   PO_APPROVER  a1_proc_poApp    the only live step of IDS.policies.A1_P1_PO
//   VENDOR_A/B   vendor_alpha / vendor_beta
//
// The award is approved over HTTP (POST /negotiation/quotes/:id/approve), which
// finalizes the vendor(s) and drafts one PO per vendor; the draft is initiated
// over HTTP (POST /po/initiate/:id). Nothing about the PO is hand-written.
//
// Mail never leaves the machine: callers mock nodemailer before importing the
// app (see the suites).

import { expect } from "@jest/globals";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "./http.js";
import { cleanupPurchaseOrders, cleanupRfqs } from "./dashboardSeed.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

export const W = Object.freeze({
  CREATOR: IDS.users.a1_proc_buyer,
  COMM_EVAL: IDS.users.a1_proc_commEval,
  COMM_APP: IDS.users.a1_proc_commApp,
  INITIATOR: IDS.users.companyA_admin,
  PO_APPROVER: IDS.users.a1_proc_poApp,
  VENDOR_A: IDS.users.vendor_alpha,
  VENDOR_B: IDS.users.vendor_beta,
});

const BUYERS = [W.CREATOR, W.COMM_EVAL, W.COMM_APP, W.INITIATOR, W.PO_APPROVER];
const VENDORS = [W.VENDOR_A, W.VENDOR_B];

export function makePoRejectWorld(db) {
  const backup = new Map();
  const rfqIds = [];
  const clients = new Map();

  const client = async (userId) => {
    if (!clients.has(userId)) clients.set(userId, await httpClient(userId));
    return clients.get(userId);
  };

  async function setup() {
    for (const u of [...BUYERS, ...VENDORS]) {
      backup.set(u, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [u]));
    }
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [BUYERS]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [VENDORS]);
  }

  async function teardown() {
    for (const [u, b] of backup) {
      await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u, b.user_type, b.status]);
    }
  }

  async function cleanup() {
    if (!rfqIds.length) return;
    const ids = rfqIds.splice(0);
    const poIds = (await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [ids])).map((r) => r.id);
    const prodIds = (await db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids])).map((r) => r.id);
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_notifications WHERE (additional_data->>'po_id')::int = ANY($1::int[])`, [poIds]);
    }
    await db.none(`DELETE FROM tbl_notifications WHERE (additional_data->>'rfq_id')::int = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_po_send_backs WHERE rfq_id = ANY($1::int[])`, [ids]);
    const inst = await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE (entity_type = 'PO' AND entity_id = ANY($1::int[]))
           OR (entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($2::int[]))`,
      [poIds, prodIds]
    );
    const instIds = inst.map((r) => r.id);
    if (instIds.length) {
      await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
           (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
        [instIds]
      );
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
    }
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
      await db.none(`UPDATE tbl_rfq_purchase_order SET replaces_po_id = NULL WHERE id = ANY($1::int[])`, [poIds]);
      await cleanupPurchaseOrders(db, poIds);
    }
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type IN ('RFQ','TENDER') AND entity_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await cleanupRfqs(db, ids);
  }

  /**
   * An ended RFQ raised by CREATOR with `products` products (variant 0, 1, ...
   * of product_variant 1) and a quote from each vendor on every product.
   */
  async function stageRfq({ products = 1, vendors = [W.VENDOR_A] } = {}) {
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, department_id, process_id, is_tender, title)
       VALUES ((SELECT COALESCE(MAX(rfq_no), 8000000) + 1 FROM tbl_rfq), '<p>e2e</p>', '', 'b@a', 'A1', '+91', $1,
               'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, $6, 0, 'po reject')
       RETURNING id, rfq_no`,
      [oneDayAgo, W.CREATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]
    );
    rfqIds.push(rfq.id);
    const quotes = {};
    for (const v of vendors) {
      quotes[v] = (await db.one(
        `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
         VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
        [rfq.id, rfq.rfq_no, v]
      )).id;
    }
    const prods = [];
    for (let variant = 0; variant < products; variant++) {
      const prod = await db.one(
        `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
         VALUES ($1, '', '', '', '', '', 1, $2) RETURNING id, product_variant_id, variant`,
        [rfq.id, variant]
      );
      prods.push(prod);
      for (const v of vendors) {
        await db.none(
          `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, 1, $2, $3)`,
          [rfq.id, v, variant]
        );
        await db.none(
          `INSERT INTO tbl_quote_items
             (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price, tax,
              freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
           VALUES ($1, $2, $3, 1, 500, 25000, 0, 0, 0, $4, '', '15', '50', 'absolute', '[]'::jsonb)`,
          [rfq.id, rfq.rfq_no, quotes[v], variant]
        );
      }
    }
    return { rfq, products: prods, quotes };
  }

  /**
   * Award `product` to `vendors`: COMM_EVAL raises the award approval, COMM_APP
   * approves it over HTTP. Returns the PO ids drafted for that product.
   */
  async function award(staged, product, vendors) {
    const approval = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE", entity_id: product.id,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: W.COMM_EVAL,
      metadata: {
        rfq_id: staged.rfq.id, rfq_number: staged.rfq.rfq_no, rfq_product_id: product.id, is_tender: 0,
        selected_quotes: vendors.map((v) => ({ quote_id: staged.quotes[v], vendor_id: v, quoted_price: 500 })),
      },
    });
    const res = await (await client(W.COMM_APP)).post(`/api/v1/negotiation/quotes/${product.id}/approve`).send({});
    expect(res.status).toBe(200);
    const pos = await db.any(
      `SELECT po.id, po.finalized_vendor_id
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
        WHERE po.rfq_id = $1 AND pop.rfq_product_id = $2 AND po.status = 'draft'
        ORDER BY po.id`,
      [staged.rfq.id, product.id]
    );
    return { approvalInstanceId: approval.instance.id, pos };
  }

  /** INITIATOR presses Initiate. Returns the PO's PENDING approval instance id. */
  async function initiate(poId) {
    const res = await (await client(W.INITIATOR)).post(`/api/v1/po/initiate/${poId}`).send({});
    expect(res.status).toBe(200);
    const po = await db.one(`SELECT status, approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
    expect(po.status).toBe("pending_approval");
    expect(po.approval_instance_id).toBeTruthy();
    return po.approval_instance_id;
  }

  /** One RFQ, one product, one vendor: a PO pending its approver. */
  async function pendingPo({ vendor = W.VENDOR_A } = {}) {
    const staged = await stageRfq({ products: 1, vendors: [vendor] });
    const { pos, approvalInstanceId: nqInstanceId } = await award(staged, staged.products[0], [vendor]);
    expect(pos).toHaveLength(1);
    const poId = pos[0].id;
    const instanceId = await initiate(poId);
    return { ...staged, product: staged.products[0], poId, instanceId, nqInstanceId };
  }

  /** The step the PO approver can act on, for the generic action endpoint. */
  async function currentStepId(instanceId) {
    const row = await db.one(
      `SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
        WHERE i.id = $1 AND s.step_order = i.current_step`,
      [instanceId]
    );
    return row.id;
  }

  /** Reject on the PO page: POST /po/approve/:po_id. */
  async function rejectOnPoPage(poId, body = {}) {
    return (await client(W.PO_APPROVER)).post(`/api/v1/po/approve/${poId}`).send({ decision: "rejected", ...body });
  }

  /** Reject on the generic approval card: POST /general/hospitality/approval/action. */
  async function rejectOnApprovalCard(instanceId, { remarks, ...rest } = {}) {
    return (await client(W.PO_APPROVER)).post(`/api/v1/general/hospitality/approval/action`).send({
      approval_instance_id: instanceId,
      approval_instance_step_id: await currentStepId(instanceId),
      action: "REJECT",
      comment: remarks,
      ...rest,
    });
  }

  /** Approve on the PO page. */
  async function approveOnPoPage(poId) {
    return (await client(W.PO_APPROVER)).post(`/api/v1/po/approve/${poId}`).send({ decision: "approved", remarks: "ok" });
  }

  return {
    setup, teardown, cleanup, client, stageRfq, award, initiate, pendingPo, currentStepId,
    rejectOnPoPage, rejectOnApprovalCard, approveOnPoPage,
  };
}

/** Rows that record a PO's rejection, for assertions. */
export const sendBacksFor = (db, poId) =>
  db.any(
    `SELECT route, reason_category, comment, requested_by, status, resolution,
            target_role, target_user_id, step_order, closed_at IS NOT NULL AS closed
       FROM tbl_po_send_backs WHERE purchase_order_id = $1 ORDER BY id`,
    [poId]
  );

/** Live finalization rows of an RFQ for one vendor. */
export const finalizationsFor = (db, rfqId, vendorId) =>
  db.any(`SELECT id, product_variant_id, variant FROM tbl_quote_finalization WHERE rfq_id = $1 AND vendor_id = $2`, [rfqId, vendorId]);
