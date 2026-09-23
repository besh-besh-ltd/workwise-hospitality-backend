/**
 * An RFQ that a PO rejection sent backwards has to say so on its card.
 *
 * RFQ 536263 (The Orchid Mumbai cafeteria, client ticket 2026-09-22) sat at
 * "PO Approval" on 8 Sep and at "Commercial Evaluation" on 16 Sep. In between,
 * Vishal Kamat rejected both of its POs — "i want full plan of the full
 * Ecoteria" — which de-finalized the products and returned the RFQ to
 * commercial evaluation. That is the system working as designed. But the card
 * said nothing about it: it simply showed a different stage with different
 * people on it, and the client concluded their approval matrix had changed.
 *
 * The reason was already stored, and the RFQ detail endpoint already returned
 * it to the re-award modal. The listing never did.
 *
 * The marker follows the rule the detail endpoint already used: a rejection is
 * shown while the product it un-awarded is still un-awarded. Once the RFQ is
 * re-awarded, the rejection no longer explains where it stands, and it goes.
 *
 * Isolation: Pattern B (commit + cleanup) — the list-view controller queries
 * `db` directly.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_poApp;
const REASON = "i want full plan of the full Ecoteria";

const made = { rfqIds: [], rfqProductIds: [], quoteIds: [], poIds: [], poLineIds: [], instIds: [], finIds: [] };
let seq = 0;
let originalUserType;

/**
 * An RFQ whose one product was on a PO that an approver rejected. The product
 * is left un-awarded, exactly as handlePORejection leaves it.
 */
async function makeRfqSentBackByPoRejection() {
  const variant = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1,
    bid_end_date: new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19),
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
  });
  made.rfqIds.push(Number(rfq_id));

  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec', '', '', '', '', $2, 0) RETURNING id, product_variant_id, variant`,
    [rfq_id, variant.id]
  );
  made.rfqProductIds.push(product.id);

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  made.quoteIds.push(quote.id);

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('PO', 0, $1, 'REJECTED', 1, $2, $3, $4, $5, $6) RETURNING id`,
    [IDS.policies.A1_P1_PO, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, BUYER, IDS.processes.A_P1]
  );
  made.instIds.push(inst.id);
  await db.none(
    `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment, created_at)
     VALUES ($1, $2, 'REJECT', $3, NOW() - interval '1 hour')`,
    [inst.id, APPROVER, REASON]
  );

  const poNumber = `REJ-${process.pid}-${++seq}`;
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, approval_instance_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'rejected', $4, 1, 100, $5, 100, $6, $7, $8, NOW(), NOW()) RETURNING id`,
    [rfq_id, IDS.companies.A, poNumber, [product.id], IDS.users.vendor_alpha, [quote.id], BUYER, inst.id]
  );
  made.poIds.push(po.id);
  const line = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, 100) RETURNING id`,
    [po.id, product.id, quote.id]
  );
  made.poLineIds.push(line.id);
  await db.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po.id, inst.id]);

  return { rfqId: Number(rfq_id), rfqNo: rfq_no, product, quoteId: quote.id, poNumber };
}

const rowFor = async (rfqId) => {
  const client = await httpClient(BUYER);
  const res = await client.post("/api/v1/rfq/list-view").send({ page: 1, limit: 100 });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data.rows.find((r) => Number(r.id) === rfqId);
};

beforeAll(async () => {
  ({ user_type: originalUserType } = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [BUYER]));
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
});

afterEach(async () => {
  const del = (sql, ids) => (ids.length ? db.none(sql, [ids]) : null);
  await del(`DELETE FROM tbl_quote_finalization WHERE id = ANY($1)`, made.finIds);
  await del(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1)`, made.poLineIds);
  await del(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1)`, made.poIds);
  await del(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1)`, made.instIds);
  await del(`DELETE FROM tbl_approval_instances WHERE id = ANY($1)`, made.instIds);
  await del(`DELETE FROM tbl_quotes WHERE id = ANY($1)`, made.quoteIds);
  await del(`DELETE FROM tbl_rfq_products WHERE id = ANY($1)`, made.rfqProductIds);
  await del(`DELETE FROM tbl_rfq WHERE id = ANY($1)`, made.rfqIds);
  for (const k of Object.keys(made)) made[k] = [];
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [BUYER, originalUserType]);
  await closeDb();
});

describe("RFQ list card — a PO rejection that sent the RFQ back", () => {
  it("tells the card which PO was rejected, by whom and why", async () => {
    const { rfqId, poNumber } = await makeRfqSentBackByPoRejection();
    const approver = await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [APPROVER]);

    const row = await rowFor(rfqId);
    expect(row).toBeDefined();
    expect(row.po_rejection).toEqual(
      expect.objectContaining({
        po_number: poNumber,
        rejection_type: "approver",
        rejected_by_name: approver.name,
        rejection_reason: REASON,
      })
    );
    expect(row.po_rejection.rejected_at).toBeTruthy();
  });

  it("drops the marker once the product is awarded again", async () => {
    // RFQ 536263 was re-awarded on 17 Sep and is back at PO approval — the
    // rejection no longer explains where it stands.
    const { rfqId, rfqNo, product, quoteId } = await makeRfqSentBackByPoRejection();
    const fin = await db.one(
      `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [rfqId, rfqNo, quoteId, product.product_variant_id, IDS.users.vendor_alpha, BUYER, product.variant]
    );
    made.finIds.push(fin.id);

    const row = await rowFor(rfqId);
    expect(row).toBeDefined();
    expect(row.po_rejection).toBeNull();
  });

  it("carries no marker on an RFQ that never had a PO rejected", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, process: IDS.processes.A_P1,
    });
    made.rfqIds.push(Number(rfq_id));

    const row = await rowFor(Number(rfq_id));
    expect(row).toBeDefined();
    expect(row.po_rejection).toBeNull();
  });

  it("still gives the re-award modal the same rejection from the RFQ detail", async () => {
    // The detail endpoint's query was moved into the model so the card and the
    // modal share one definition. Pin that the modal's data did not change.
    const { rfqId, poNumber } = await makeRfqSentBackByPoRejection();

    const client = await httpClient(BUYER);
    const res = await client.get(`/api/v1/rfq/getRfqById/${rfqId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.vendor_rejections).toEqual([
      expect.objectContaining({
        po_number: poNumber,
        rejection_type: "approver",
        rejection_reason: REASON,
      }),
    ]);
  });
});

