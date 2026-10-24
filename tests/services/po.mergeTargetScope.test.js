// A merge target the client chooses (existing_po_id) must be a DRAFT PO of the
// SAME RFQ for the SAME vendor: the auto-merge criteria minus project and
// hierarchy. draftPurchaseOrder used to check only that the PO existed, then
// rewrote its selected_hierarchy and appended a line to it, so a crafted
// finalize or approve request could write into another RFQ's (or another
// company's) purchase order, or into one already under approval.
//
// The same-RFQ match only scopes the PO because the RFQ itself is gated:
// finalize checks the caller can read the RFQ, approve checks the caller is an
// approver on the instance. Both are pinned here, as is the id's shape ("5.0",
// "5e0" and [5] are refused, not coerced) and the post-approval fallback (a
// target that goes stale once the approval has committed is set aside, never
// left as "approved, no PO").
//
// Real Postgres, real HTTP for the three request paths (POST /rfq/finalize,
// POST /negotiation/quotes/:rfq_product_id/approve and the approval engine's
// POST /general/hospitality/approval/action). Every test commits and the
// afterEach removes what it created.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import { draftPurchaseOrder } from "../../app/models/purchaseOrderModel.js";

const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_commApp; // the A1/P1 NEGOTIATION_QUOTE approver
const OTHER_COMPANY_BUYER = IDS.users.companyB_admin; // company-level scope on Company B only
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;
const REFUSED = { code: "PO_MERGE_TARGET_INVALID", httpStatus: 400 };

let VARIANT = 1;

// The routes are gated by acl() on tbl_users.user_type, which the fixture users
// leave NULL; set it for this suite and put it back afterwards.
const ROUTE_USERS = [BUYER, APPROVER, OTHER_COMPANY_BUYER];
let savedUserTypes = [];
beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT = v.id;
  savedUserTypes = await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [ROUTE_USERS]);
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [ROUTE_USERS]);
});
afterAll(async () => {
  for (const u of savedUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
  await closeDb();
});

const made = { rfqIds: [] };
beforeEach(() => { made.rfqIds = []; });
afterEach(async () => {
  const ids = made.rfqIds;
  if (!ids.length) return;
  const instances = await db.any(
    `SELECT ai.id FROM tbl_approval_instances ai
       JOIN tbl_rfq_products rp ON rp.id = ai.entity_id
      WHERE ai.entity_type IN ('NEGOTIATION_QUOTE', 'PO') AND rp.rfq_id = ANY($1::int[])
     UNION
     SELECT ai.id FROM tbl_approval_instances ai
       JOIN tbl_rfq_purchase_order po ON po.id = ai.entity_id
      WHERE ai.entity_type = 'PO' AND po.rfq_id = ANY($1::int[])`,
    [ids]
  );
  const instanceIds = instances.map((r) => r.id);
  await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE rfq_id = ANY($1::int[])`, [ids]);
  if (instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  await db.none(
    `DELETE FROM tbl_purchase_order_product
      WHERE purchase_order_id IN (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[]))`,
    [ids]
  );
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id IN
                   (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type <> 'PO'`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
});

// ---- fixtures ---------------------------------------------------------------

const tsString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
let seq = 0;

/** A published, non-tender RFQ past its bid deadline, of company A (A1/P1) or B. */
async function makeRfq({ company = "A" } = {}) {
  const [hosp, hotel, process, creator] = company === "A"
    ? [IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, BUYER]
    : [IDS.hospitality.B, IDS.hotels.B1, IDS.processes.B_P1, IDS.users.companyB_admin];
  const { n } = await db.one(`SELECT COALESCE(MAX(rfq_no), 900000) + 1 + $1 AS n FROM tbl_rfq`, [seq++]);
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, title)
     VALUES ($1, '<p>merge</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3,
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'), $4, $5, $6, 0, 'merge target fixture')
     RETURNING id, rfq_no`,
    [n, tsString(-3600_000), creator, hosp, hotel, process]
  );
  made.rfqIds.push(rfq.id);
  return { rfqId: rfq.id, rfqNo: Number(rfq.rfq_no), companyId: company === "A" ? IDS.companies.A : IDS.companies.B };
}

/** One product on `rfq` and `vendor`'s quote for it. */
async function quotedProduct(rfq, vendor = VENDOR, { variant = 0 } = {}) {
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, $3) RETURNING id`,
    [rfq.rfqId, VARIANT, variant]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [rfq.rfqId, VARIANT, vendor, variant]
  );
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) RETURNING id`,
    [rfq.rfqId, rfq.rfqNo, vendor]
  );
  const qi = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
        tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, 100, 300, 0, 18, 0, $5, 'q', '7', '3', 'percentage', '[]') RETURNING id`,
    [rfq.rfqId, rfq.rfqNo, q.id, VARIANT, variant]
  );
  return { rfqProductId: Number(rp.id), quoteItemId: Number(qi.id), vendor };
}

/**
 * A PO header with one line on `rfq`, for `vendor`, in `status`. The line is
 * its own product (variant `variant`), so a finalize of another variant-0
 * line on the same RFQ resolves one product row.
 */
async function makePo(rfq, { vendor = VENDOR, status = "draft", hierarchy = null, variant = 0 } = {}) {
  const line = await quotedProduct(rfq, vendor, { variant });
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, selected_hierarchy)
     VALUES ($1, $2, $3, $4, '{}', 2, 100, $5, 200, '{}', $6, $7) RETURNING id`,
    [rfq.rfqId, rfq.companyId, `MT-${rfq.rfqId}-${seq++}`, status, vendor, BUYER, hierarchy]
  );
  await db.none(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price, charges_meta)
     VALUES ($1, $2, $3, 2, 'kg', 100, 200, '{"tax":18,"tax_mode":"percentage"}'::jsonb)`,
    [po.id, line.rfqProductId, line.quoteItemId]
  );
  return Number(po.id);
}

/** What a merge would change on a PO. */
const poState = (poId) => db.one(
  `SELECT po.status::text AS status, po.selected_hierarchy::text AS hierarchy, po.total_value::text AS total,
          (SELECT count(*)::int FROM tbl_purchase_order_product l WHERE l.purchase_order_id = po.id) AS lines
     FROM tbl_rfq_purchase_order po WHERE po.id = $1`,
  [poId]
);

const productInfo = (line) => ({
  rfq_product_id: line.rfqProductId, quantity: 3, unit: "kg", unit_price: 100,
  charges_meta: { tax: 18, tax_mode: "percentage" }, finalized_vendor_id: line.vendor,
});

/** Award `line` of `rfq` through the model, onto `existingPoId`, asking for hierarchy 777. */
const award = (rfq, line, existingPoId, opts) => db.tx((t) => draftPurchaseOrder(
  rfq.rfqId, null, line.quoteItemId, 354, productInfo(line), BUYER, IDS.companies.A,
  { id: BUYER, company_id: IDS.companies.A }, existingPoId, 777, t, [], 354, opts
));

/** The finalize request body for `line` of `rfq`. */
const finalizeBody = (rfq, line, extra = {}) => ({
  rfq_id: rfq.rfqId, rfq_no: rfq.rfqNo, product_variant_id: VARIANT, variant: 0,
  vendor_id: VENDOR, quote_id: line.quoteItemId, quote_item_id: line.quoteItemId,
  route_type: "PO", comment: "awarding after evaluation", project_id: null,
  product_info: productInfo(line), ...extra,
});

/** What an award of `line` of `rfq` left behind: finalizations, POs, parked approvals. */
const awardTrail = async (rfq, line) => ({
  finalizations: await db.any(`SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfqId]),
  pos: await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1 ORDER BY id`, [rfq.rfqId]),
  approvals: await db.any(
    `SELECT id FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = $1`,
    [line.rfqProductId]
  ),
});

/** The id shapes that name PO `id` but are not an id: refused, not coerced. */
const malformed = (id) => [[id], `${id}.0`, `${id}e0`];

// ---- the model ------------------------------------------------------------------

describe("draftPurchaseOrder with a client-chosen existing_po_id", () => {
  it("refuses another RFQ's draft and another company's PO, and leaves them as they were", async () => {
    const rfq = await makeRfq();
    const line = await quotedProduct(rfq);
    const otherRfqDraft = await makePo(await makeRfq());
    const otherCompanyDraft = await makePo(await makeRfq({ company: "B" }));

    for (const target of [otherRfqDraft, otherCompanyDraft]) {
      const before = await poState(target);
      await expect(award(rfq, line, target)).rejects.toMatchObject(REFUSED);
      expect(await poState(target)).toEqual(before);
    }
    // Nothing was drafted on this RFQ either: the award failed as a whole.
    expect(await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId])).toEqual([]);
  });

  it("refuses a PO of the same RFQ that is past draft, or another vendor's, or unknown", async () => {
    const rfq = await makeRfq();
    const line = await quotedProduct(rfq);
    const pending = await makePo(rfq, { status: "pending_approval" });
    const otherVendor = await makePo(rfq, { vendor: OTHER_VENDOR });

    for (const target of [pending, otherVendor]) {
      const before = await poState(target);
      await expect(award(rfq, line, target)).rejects.toMatchObject(REFUSED);
      expect(await poState(target)).toEqual(before);
    }
    await expect(award(rfq, line, 2147483000)).rejects.toMatchObject(REFUSED);
  });

  it("still merges into this RFQ's draft for the same vendor", async () => {
    const rfq = await makeRfq();
    const target = await makePo(rfq);
    const line = await quotedProduct(rfq);

    const out = await award(rfq, line, target);
    expect(out).toMatchObject({ po_id: target, created: false });
    expect(await poState(target)).toMatchObject({ status: "draft", hierarchy: "777", lines: 2 });
  });

  it("refuses an id that only coerces to a valid draft (\"D.0\", \"De0\", [D]), and takes a digit string", async () => {
    const rfq = await makeRfq();
    const target = await makePo(rfq, { hierarchy: 4242 });
    const before = await poState(target);

    for (const shape of malformed(target)) {
      const line = await quotedProduct(rfq);
      await expect(award(rfq, line, shape)).rejects.toMatchObject(REFUSED);
      expect(await poState(target)).toEqual(before);
    }
    const line = await quotedProduct(rfq);
    expect(await award(rfq, line, String(target))).toMatchObject({ po_id: target, created: false });
  });

  it("with staleTargetFallback, a refused target is set aside under the lock and the line is drafted without it", async () => {
    const rfq = await makeRfq();
    const pending = await makePo(rfq, { status: "pending_approval" });
    const line = await quotedProduct(rfq);
    const before = await poState(pending);

    const out = await award(rfq, line, pending, { staleTargetFallback: true });

    expect(out).toMatchObject({ created: true });
    expect(out.po_id).not.toBe(pending);
    expect(await poState(pending)).toEqual(before);
    expect(await poState(out.po_id)).toMatchObject({ status: "draft", lines: 1 });
  });
});

// ---- the request paths ------------------------------------------------------------

describe("POST /rfq/finalize with existing_po_id", () => {
  const finalize = async (userId, body) => (await httpClient(userId)).post("/api/v1/rfq/finalize").send(body);

  it("answers 400 for another RFQ's PO, before anything is awarded or parked", async () => {
    const rfq = await makeRfq();
    const line = await quotedProduct(rfq);
    const foreign = await makePo(await makeRfq());
    const before = await poState(foreign);

    const res = await finalize(BUYER, finalizeBody(rfq, line, { existing_po_id: foreign }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 0, code: "PO_MERGE_TARGET_INVALID" });
    expect(await poState(foreign)).toEqual(before);
    expect(await awardTrail(rfq, line)).toEqual({ finalizations: [], pos: [], approvals: [] });
  });

  it("refuses a buyer of another company outright: scope error, nothing awarded, drafted or parked", async () => {
    const rfq = await makeRfq();
    const draft = await makePo(rfq, { variant: 1 });
    const line = await quotedProduct(rfq);
    const before = await poState(draft);
    const trailBefore = await awardTrail(rfq, line);

    for (const extra of [{}, { existing_po_id: draft }]) {
      const res = await finalize(OTHER_COMPANY_BUYER, finalizeBody(rfq, line, extra));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ status: 3, code: "PROCESS_NOT_IN_USER_SCOPE" });
    }
    expect(await poState(draft)).toEqual(before);
    expect(await awardTrail(rfq, line)).toEqual(trailBefore);
  });

  it("refuses an id that only coerces to this RFQ's draft (\"D.0\", \"De0\", [D]) with 400, writing nothing", async () => {
    const rfq = await makeRfq();
    const draft = await makePo(rfq, { hierarchy: 4242, variant: 1 });
    const line = await quotedProduct(rfq);
    const before = await poState(draft);
    const trailBefore = await awardTrail(rfq, line);

    for (const shape of malformed(draft)) {
      const res = await finalize(BUYER, finalizeBody(rfq, line, { existing_po_id: shape }));

      expect(res.status).toBe(400);
      // [D] is not a number at all, so the request schema refuses it first.
      if (!Array.isArray(shape)) expect(res.body).toMatchObject({ status: 0, code: "PO_MERGE_TARGET_INVALID" });
      expect(await poState(draft)).toEqual(before);
      expect(await awardTrail(rfq, line)).toEqual(trailBefore);
    }
  });
});

describe("POST /negotiation/quotes/:rfq_product_id/approve with existing_po_id", () => {
  /** A finalize parked for approval, as rfqController.finalize stores it. */
  // The payload asks for hierarchy 4243 and the targets below carry 4242, so
  // the auto-merge never picks them: a line that lands on one got there as the
  // chosen target.
  async function parkedAward(rfq, line, { parkedPoId = null } = {}) {
    const result = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE",
      entity_id: line.rfqProductId,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: null,
      process_id: IDS.processes.A_P1,
      initiated_by: BUYER,
      metadata: {
        rfq_id: rfq.rfqId, rfq_number: rfq.rfqNo, rfq_product_id: line.rfqProductId, is_tender: 0,
        product_variant_id: VARIANT, variant: 0, vendor_id: VENDOR, quote_id: line.quoteItemId,
        quote_item_id: line.quoteItemId,
        po_payload: {
          rfq_id: rfq.rfqId, rfq_no: rfq.rfqNo, product_variant_id: VARIANT, variant: 0, vendor_id: VENDOR,
          quote_id: line.quoteItemId, quote_item_id: line.quoteItemId, route_type: "PO", project_id: null,
          product_info: productInfo(line), existing_po_id: parkedPoId, selected_hierarchy: 4243,
        },
        po_user: { id: BUYER, company_id: IDS.companies.A },
      },
    });
    expect(result.instance.status).toBe("PENDING");
    return result.instance.id;
  }
  const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
  const approve = async (line, body, userId = APPROVER) =>
    (await httpClient(userId)).post(`/api/v1/negotiation/quotes/${line.rfqProductId}/approve`).send(body);
  /** The approval engine's own endpoint, which runs negotiationQuotePostApproval. */
  const engineApprove = async (instanceId) =>
    (await httpClient(APPROVER)).post("/api/v1/general/hospitality/approval/action")
      .send({ approval_instance_id: instanceId, action: "APPROVE", comment: "approving" });
  /** Every PO of `rfq` carrying `line`. */
  const posWithLine = async (rfq, line) => (await db.any(
    `SELECT DISTINCT po.id FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product l ON l.purchase_order_id = po.id
      WHERE po.rfq_id = $1 AND l.rfq_product_id = $2`,
    [rfq.rfqId, line.rfqProductId]
  )).map((r) => ({ id: Number(r.id) }));

  it("answers 400 for another RFQ's PO and records no approval", async () => {
    const rfq = await makeRfq();
    const line = await quotedProduct(rfq);
    const foreign = await makePo(await makeRfq());
    const before = await poState(foreign);
    const instanceId = await parkedAward(rfq, line);

    const res = await approve(line, { remarks: "approving", existing_po_id: foreign });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 0, code: "PO_MERGE_TARGET_INVALID" });
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await poState(foreign)).toEqual(before);
    expect(await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId])).toEqual([]);
  });

  it("a parked target that has since left draft is set aside: the line gets a draft of its own", async () => {
    const rfq = await makeRfq();
    const parked = await makePo(rfq);
    const line = await quotedProduct(rfq);
    const instanceId = await parkedAward(rfq, line, { parkedPoId: parked });
    // The chosen draft went for approval while this award waited.
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [parked]);
    const before = await poState(parked);

    const res = await approve(line, { remarks: "approving" });

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect(await poState(parked)).toEqual(before);
    const drafts = await db.any(
      `SELECT po.id FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product l ON l.purchase_order_id = po.id
        WHERE po.rfq_id = $1 AND po.status = 'draft' AND l.rfq_product_id = $2`,
      [rfq.rfqId, line.rfqProductId]
    );
    expect(drafts).toHaveLength(1);
  });

  it("refuses an id that only coerces to this RFQ's draft (\"D.0\", \"De0\", [D]) with 400 and records no approval", async () => {
    const rfq = await makeRfq();
    const draft = await makePo(rfq, { hierarchy: 4242 });
    const line = await quotedProduct(rfq);
    const instanceId = await parkedAward(rfq, line);
    const before = await poState(draft);

    for (const shape of malformed(draft)) {
      const res = await approve(line, { remarks: "approving", existing_po_id: shape });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 0, code: "PO_MERGE_TARGET_INVALID" });
      expect(await instanceStatus(instanceId)).toBe("PENDING");
      expect(await poState(draft)).toEqual(before);
      expect(await posWithLine(rfq, line)).toEqual([]);
    }
  });

  it("a caller who is not an approver on the instance gets the engine's answer, whatever the target", async () => {
    const rfq = await makeRfq();
    const draft = await makePo(rfq, { hierarchy: 4242 });
    const line = await quotedProduct(rfq);
    const foreign = await makePo(await makeRfq());
    const instanceId = await parkedAward(rfq, line);
    const before = await poState(draft);

    const answers = [];
    for (const body of [{}, { existing_po_id: draft }, { existing_po_id: foreign }, { existing_po_id: "x" }]) {
      const res = await approve(line, { remarks: "approving", ...body }, BUYER);
      answers.push({ status: res.status, body: res.body });
    }

    // One answer for all four, and it is submitApprovalAction's own refusal
    // of a non-approver: nothing about the PO ids leaks.
    expect(answers[0]).toEqual({ status: 400, body: { status: 3, message: "User is not an approver for this step" } });
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await poState(draft)).toEqual(before);
  });

  it("a parked target that is still this RFQ's draft takes the line at approval", async () => {
    const rfq = await makeRfq();
    const parked = await makePo(rfq, { hierarchy: 4242 });
    const line = await quotedProduct(rfq);
    const instanceId = await parkedAward(rfq, line, { parkedPoId: parked });

    const res = await approve(line, { remarks: "approving" });

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect(await poState(parked)).toMatchObject({ status: "draft", hierarchy: "4243", lines: 2 });
    expect(await posWithLine(rfq, line)).toEqual([{ id: parked }]);
  });

  it("the approver's own target (sent as a digit string) takes the line", async () => {
    const rfq = await makeRfq();
    const chosen = await makePo(rfq, { hierarchy: 4242 });
    const line = await quotedProduct(rfq);
    const instanceId = await parkedAward(rfq, line);

    const res = await approve(line, { remarks: "approving", existing_po_id: String(chosen) });

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect(await poState(chosen)).toMatchObject({ status: "draft", hierarchy: "4243", lines: 2 });
    expect(await posWithLine(rfq, line)).toEqual([{ id: chosen }]);
  });

  describe("approved through the approval engine (negotiationQuotePostApproval)", () => {
    it("a parked target that is still this RFQ's draft takes the line", async () => {
      const rfq = await makeRfq();
      const parked = await makePo(rfq, { hierarchy: 4242 });
      const line = await quotedProduct(rfq);
      const instanceId = await parkedAward(rfq, line, { parkedPoId: parked });

      const res = await engineApprove(instanceId);

      expect(res.status).toBe(200);
      expect(await instanceStatus(instanceId)).toBe("APPROVED");
      expect(await poState(parked)).toMatchObject({ status: "draft", hierarchy: "4243", lines: 2 });
      expect(await posWithLine(rfq, line)).toEqual([{ id: parked }]);
    });

    it("a parked target that has left draft is set aside: the approved line still gets a draft", async () => {
      const rfq = await makeRfq();
      const parked = await makePo(rfq, { hierarchy: 4242 });
      const line = await quotedProduct(rfq);
      const instanceId = await parkedAward(rfq, line, { parkedPoId: parked });
      await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [parked]);
      const before = await poState(parked);

      const res = await engineApprove(instanceId);

      expect(res.status).toBe(200);
      expect(await instanceStatus(instanceId)).toBe("APPROVED");
      expect(await poState(parked)).toEqual(before);
      const drafts = await posWithLine(rfq, line);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].id).not.toBe(parked);
      expect(await poState(drafts[0].id)).toMatchObject({ status: "draft", lines: 1 });
    });
  });
});
