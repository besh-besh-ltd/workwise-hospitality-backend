/**
 * A PO rejection must be recorded in the activity trail as a rejection.
 *
 * RFQ 536263 (The Orchid Mumbai, client ticket 2026-09-22). Vishal Kamat
 * rejected POs 138721 and 138733 on 11 Sep, asking for a full plan of the
 * outlet. The only LIVE row the trail holds for either decision reads:
 *
 *   event_key po_approved · POST /po/approve/:po_id 200 ·
 *   "Vishal Kamat approved purchase order 138721"
 *
 * The rows that say "rejected" are BACKFILL, reconstructed later from other
 * tables. The registry keyed the event on the route, and `/po/approve/:po_id`
 * serves both decisions — `decision` in the body chooses — so every PO
 * rejection taken on the PO page has gone into the trail as an approval. An
 * admin reading the trail, or anyone filtering it by event, sees the opposite
 * of what happened.
 *
 * Every other decision endpoint in the registry already does this correctly: a
 * neutral key (`rfq_approval_decided`, `approval_decided`) and a summary that
 * reads the body. This brings the PO entry into line.
 *
 * Isolation: Pattern B (commit + cleanup) — real HTTP, and the capture
 * middleware writes on its own connection after the response finishes.
 */
import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { EVENTS } from "../../app/services/activity/eventRegistry.js";

const APPROVER = IDS.users.a1_proc_poApp;
const inserted = { rfqIds: [], rfqProductIds: [], quoteIds: [], poIds: [], poProductIds: [], instIds: [] };
let poSeq = 0;

// The capture runs on the response's `finish` event, off the request's
// critical path, so it lands a moment after the client has its answer.
const waitForEvent = async (since, poId, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT event_key, summary, status_code, source
         FROM tbl_activity_events
        WHERE occurred_at >= $1 AND entity_type = 'PO' AND entity_id = $2 AND source = 'HTTP'
        ORDER BY id DESC LIMIT 1`,
      [since, poId]
    );
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A PO sitting on step 1 of its approval, assigned to APPROVER. */
async function makePoAwaitingApproval() {
  const variant = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer, status: 1, is_published: 1,
    bid_end_date: new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19),
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec', '', '', '', '', $2, 0) RETURNING id`,
    [rfq_id, variant.id]
  );
  inserted.rfqProductIds.push(product.id);

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', 0, $1, 'PENDING', 1, $2, $3, $4, $5, $6) RETURNING id`,
    [IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
     IDS.users.a1_proc_buyer, IDS.processes.A_P1]
  );
  inserted.instIds.push(inst.id);
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step.id, APPROVER]
  );

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, approval_instance_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending_approval', $4, 1, 100, $5, 100, $6, $7, $8, NOW(), NOW()) RETURNING id`,
    [rfq_id, IDS.companies.A, `AUDIT-${process.pid}-${++poSeq}`, [product.id],
     IDS.users.vendor_alpha, [quote.id], IDS.users.a1_proc_buyer, inst.id]
  );
  inserted.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, 100) RETURNING id`,
    [po.id, product.id, quote.id]
  );
  inserted.poProductIds.push(line.id);
  await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po.id, inst.id]);
  return po.id;
}

afterEach(async () => {
  const del = (sql, ids) => (ids.length ? db.none(sql, [ids]) : null);
  await del(`DELETE FROM tbl_activity_events WHERE entity_type = 'PO' AND entity_id = ANY($1)`, inserted.poIds);
  await del(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1)`, inserted.poProductIds);
  await del(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1)`, inserted.poIds);
  await del(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1)`, inserted.instIds);
  await del(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
       (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1))`,
    inserted.instIds
  );
  await del(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1)`, inserted.instIds);
  await del(`DELETE FROM tbl_approval_instances WHERE id = ANY($1)`, inserted.instIds);
  await del(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1)`, inserted.rfqIds);
  await del(`DELETE FROM tbl_quotes WHERE id = ANY($1)`, inserted.quoteIds);
  await del(`DELETE FROM tbl_rfq_products WHERE id = ANY($1)`, inserted.rfqProductIds);
  await del(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, inserted.rfqIds);
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterAll(async () => {
  await closeDb();
});

describe("activity trail — PO approval decisions", () => {
  it("records a PO rejection as a rejection, not an approval", async () => {
    const poId = await makePoAwaitingApproval();
    const since = new Date();

    const client = await httpClient(APPROVER);
    const res = await client
      .post(`/api/v1/po/approve/${poId}`)
      .send({ decision: "rejected", remarks: "i want full plan of the full Ecoteria" });
    expect(res.status).toBe(200);

    const event = await waitForEvent(since, poId);
    expect(event).not.toBeNull();
    expect(event.summary).toMatch(/\brejected purchase order\b/);
    expect(event.summary).not.toMatch(/\bapproved\b/);
  });

  it("files the decision under a neutral key, so filtering by event cannot mislead", async () => {
    const poId = await makePoAwaitingApproval();
    const since = new Date();

    const client = await httpClient(APPROVER);
    await client.post(`/api/v1/po/approve/${poId}`).send({ decision: "rejected", remarks: "no" });

    const event = await waitForEvent(since, poId);
    expect(event.event_key).toBe("po_approval_decided");
  });

  it("still says 'approved' when the approver approves", () => {
    // Asserted at the registry: the approve path renders the PO document, which
    // needs a real browser this shard does not install. The wording is what
    // changed; the capture path is proven end to end by the rejection above.
    const def = EVENTS.find((d) => d.method === "POST" && d.path === "/po/approve/:po_id");
    const ctx = { actor: "Vishal Kamat", entityLabel: "138721", body: { decision: "approved" } };
    expect(def.summary(ctx)).toBe("Vishal Kamat approved purchase order 138721");
  });

  it("does not claim a decision the request never carried", () => {
    // A request with no valid decision is refused with 400; the trail must not
    // turn a refused request into "approved" or "rejected".
    const def = EVENTS.find((d) => d.method === "POST" && d.path === "/po/approve/:po_id");
    const ctx = { actor: "Vishal Kamat", entityLabel: "138721", body: {} };
    expect(def.summary(ctx)).not.toMatch(/\b(approved|rejected)\b/);
  });
});
