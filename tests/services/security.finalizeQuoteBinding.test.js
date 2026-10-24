// An award names the quote line it prices from by id, and the ids came from the
// request body. POST /rfq/finalize gated the RFQ (assertCanReadParentRfq) and
// then trusted quote_item_id, quote_id and product_info: buildAuthoritativePOPayload
// copied the unit price, tax and charges of whatever tbl_quote_items row the id
// named onto the PO line, and draftPO the global charges of its quote. A buyer
// awarding their OWN RFQ could pass another tenant's quote line and read that
// vendor's pricing back on their PO, or award vendor X at vendor Y's price.
//
// Pinned here, through HTTP:
//   - finalize refuses a quote line that is not this RFQ's (404, the same answer
//     for another company's and for this company's other RFQ), and inside this
//     RFQ: another vendor's line, a line for another product, a quote_id that is
//     not the line's quote, product_info naming another product or vendor (400).
//     Nothing is written: no finalization, no PO, no PO line, no parked approval.
//   - a parked finalize payload is bound again before its approval is recorded,
//     on both approval surfaces (approveQuotes and the approval engine).
//   - submit-for-approval only accepts round quotes of this RFQ and product.
//   - finalize refuses a same-company buyer outside the RFQ's hotel or
//     department (403), and no scope refusal echoes the refused record's ids.
//
// Real Postgres; every test commits and the afterEach removes what it created.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const BUYER = IDS.users.a1_proc_buyer;           // A-1 procurement
const APPROVER = IDS.users.a1_proc_commApp;      // the A1/P1 NEGOTIATION_QUOTE approver
const ENG_BUYER = IDS.users.a1_eng_buyer;        // A-1, engineering department only
const MULTI_HOTEL = IDS.users.multiHotel;        // A-1 and A-2 procurement
const OTHER_COMPANY = IDS.users.companyB_admin;  // Company B only
const ALPHA = IDS.users.vendor_alpha;
const BETA = IDS.users.vendor_beta;

const ROUTE_USERS = [BUYER, APPROVER, ENG_BUYER, MULTI_HOTEL, OTHER_COMPANY];
let savedUserTypes = [];
let VARIANT = 1;

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
      WHERE ai.entity_type IN ('NEGOTIATION_QUOTE', 'ARC') AND rp.rfq_id = ANY($1::int[])
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
  await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id IN
                   (SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type <> 'PO'`, [ids]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(
    `DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id IN
       (SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[]))`,
    [ids]
  );
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
});

// ---- fixtures ---------------------------------------------------------------

const tsString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
let seq = 0;

/** A published, non-tender RFQ past its bid deadline. Company A defaults to A-1 / A_P1. */
async function makeRfq({ company = "A", hotel, process, dept = null } = {}) {
  const isA = company === "A";
  const hosp = isA ? IDS.hospitality.A : IDS.hospitality.B;
  const creator = isA ? BUYER : OTHER_COMPANY;
  const { n } = await db.one(`SELECT COALESCE(MAX(rfq_no), 900000) + 1 + $1 AS n FROM tbl_rfq`, [seq++]);
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, department_id, is_tender, title)
     VALUES ($1, '<p>bind</p>', '', 'b@a', 'A1', '+91', $2, 'Mumbai', 1, 1, $3, $3,
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'), $4, $5, $6, $7, 0, 'quote binding fixture')
     RETURNING id, rfq_no`,
    [
      n, tsString(-3600_000), creator, hosp,
      hotel ?? (isA ? IDS.hotels.A1 : IDS.hotels.B1),
      process === undefined ? (isA ? IDS.processes.A_P1 : IDS.processes.B_P1) : process,
      dept,
    ]
  );
  made.rfqIds.push(rfq.id);
  return { rfqId: Number(rfq.id), rfqNo: Number(rfq.rfq_no) };
}

/** A product on `rfq`. Products of one RFQ need distinct `variant`s. */
async function addProduct(rfq, { variant = 0 } = {}) {
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, $3) RETURNING id`,
    [rfq.rfqId, VARIANT, variant]
  );
  return { rfqProductId: Number(rp.id), variant };
}

/** `vendor`'s quote on `rfq`, with one line for `product` at `unitPrice`. */
async function addQuote(rfq, product, vendor = ALPHA, unitPrice = 100) {
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [rfq.rfqId, VARIANT, vendor, product.variant]
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
     VALUES ($1, $2, $3, $4, $5, $5 * 3, 0, 18, 0, $6, 'q', '7', '3', 'percentage', '[]') RETURNING id`,
    [rfq.rfqId, rfq.rfqNo, q.id, VARIANT, unitPrice, product.variant]
  );
  return { quoteId: Number(q.id), quoteItemId: Number(qi.id), vendor };
}

/** The finalize body the comparison screen sends for `quote` on `product` of `rfq`. */
const finalizeBody = (rfq, product, quote, extra = {}) => ({
  rfq_id: rfq.rfqId, rfq_no: rfq.rfqNo, product_variant_id: VARIANT, variant: product.variant,
  vendor_id: quote.vendor, quote_id: quote.quoteId, quote_item_id: quote.quoteItemId,
  route_type: "PO", comment: "awarding after evaluation", project_id: null, total_value: 354,
  product_info: {
    rfq_product_id: product.rfqProductId, quantity: 3, unit: "kg", unit_price: 100,
    charges_meta: { tax: 18, tax_mode: "percentage" }, finalized_vendor_id: quote.vendor,
  },
  ...extra,
});

const finalize = async (userId, body) => (await httpClient(userId)).post("/api/v1/rfq/finalize").send(body);

/** Everything an award of `rfq` can write. */
const trail = async (rfq) => ({
  finalizations: await db.any(`SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfqId]),
  pos: await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId]),
  lines: await db.any(
    `SELECT l.id FROM tbl_purchase_order_product l
       JOIN tbl_rfq_purchase_order po ON po.id = l.purchase_order_id WHERE po.rfq_id = $1`,
    [rfq.rfqId]
  ),
  approvals: await db.any(
    `SELECT ai.id FROM tbl_approval_instances ai
       JOIN tbl_rfq_products rp ON rp.id = ai.entity_id
      WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND rp.rfq_id = $1`,
    [rfq.rfqId]
  ),
});
const NOTHING = { finalizations: [], pos: [], lines: [], approvals: [] };

const NOT_FOUND = { status: 0, code: "AWARD_QUOTE_NOT_FOUND" };
const MISMATCH = { status: 0, code: "AWARD_QUOTE_MISMATCH" };

// ---- finalize -----------------------------------------------------------------

describe("POST /rfq/finalize binds the quote line to the gated RFQ", () => {
  it("refuses another company's quote line with 404 and writes nothing", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const own = await addQuote(rfq, product, ALPHA, 100);
    // Company B's RFQ: the same vendor, the same product variant, a different price.
    const rfqB = await makeRfq({ company: "B" });
    const productB = await addProduct(rfqB);
    const foreign = await addQuote(rfqB, productB, ALPHA, 777);

    const res = await finalize(BUYER, finalizeBody(rfq, product, own, {
      quote_id: foreign.quoteId, quote_item_id: foreign.quoteItemId,
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject(NOT_FOUND);
    expect(JSON.stringify(res.body)).not.toContain("777");
    expect(await trail(rfq)).toEqual(NOTHING);
    expect(await trail(rfqB)).toEqual(NOTHING);
  });

  it("refuses this company's quote line from a different RFQ with the same 404", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const own = await addQuote(rfq, product);
    const otherRfq = await makeRfq();
    const otherLine = await addQuote(otherRfq, await addProduct(otherRfq));

    const res = await finalize(BUYER, finalizeBody(rfq, product, own, {
      quote_id: otherLine.quoteId, quote_item_id: otherLine.quoteItemId,
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject(NOT_FOUND);
    expect(await trail(rfq)).toEqual(NOTHING);
    expect(await trail(otherRfq)).toEqual(NOTHING);
  });

  it("refuses another vendor's quote line on the same RFQ, awarded as the chosen vendor (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    await addQuote(rfq, product, ALPHA, 100);
    const betaLine = await addQuote(rfq, product, BETA, 90);

    // Award ALPHA, priced from BETA's line.
    const res = await finalize(BUYER, finalizeBody(rfq, product, { ...betaLine, vendor: ALPHA }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(MISMATCH);
    expect(await trail(rfq)).toEqual(NOTHING);
  });

  it("refuses product_info naming another product of the RFQ (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq, { variant: 0 });
    const other = await addProduct(rfq, { variant: 1 });
    const line = await addQuote(rfq, product);

    const body = finalizeBody(rfq, product, line);
    body.product_info.rfq_product_id = other.rfqProductId;
    const res = await finalize(BUYER, body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(MISMATCH);
    expect(await trail(rfq)).toEqual(NOTHING);
  });

  it("refuses the vendor's quote line for a different product than the one awarded (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq, { variant: 0 });
    const other = await addProduct(rfq, { variant: 1 });
    const otherLine = await addQuote(rfq, other);

    const res = await finalize(BUYER, finalizeBody(rfq, product, otherLine));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(MISMATCH);
    expect(await trail(rfq)).toEqual(NOTHING);
  });

  it("refuses a quote_id that is not the line's quote, and a product_info vendor that is not the awarded one (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product, ALPHA);
    const betaLine = await addQuote(rfq, product, BETA);

    const wrongQuote = await finalize(BUYER, finalizeBody(rfq, product, line, { quote_id: betaLine.quoteId }));
    const body = finalizeBody(rfq, product, line);
    body.product_info.finalized_vendor_id = BETA;
    const wrongVendor = await finalize(BUYER, body);

    for (const res of [wrongQuote, wrongVendor]) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(MISMATCH);
    }
    expect(await trail(rfq)).toEqual(NOTHING);
  });

  it("still awards a quote line that binds", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);

    const res = await finalize(BUYER, finalizeBody(rfq, product, line));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const fin = await db.one(`SELECT vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfqId]);
    expect(fin).toEqual({ vendor_id: ALPHA, quote_id: line.quoteId });
  });
});

// ---- a parked award, at approval -------------------------------------------------

describe("a parked finalize payload is bound again before its approval is recorded", () => {
  /** A finalize parked for approval, as rfqController.finalize stores it, with `payload` overrides. */
  async function parkedAward(rfq, product, line, payload = {}) {
    const result = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE",
      entity_id: product.rfqProductId,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: null,
      process_id: IDS.processes.A_P1,
      initiated_by: BUYER,
      metadata: {
        rfq_id: rfq.rfqId, rfq_number: rfq.rfqNo, rfq_product_id: product.rfqProductId, is_tender: 0,
        product_variant_id: VARIANT, variant: product.variant, vendor_id: ALPHA, quote_id: line.quoteId,
        quote_item_id: line.quoteItemId,
        po_payload: {
          ...finalizeBody(rfq, product, line),
          quote_id: line.quoteItemId, // finalize parks quote_id = the quote line id
          ...payload,
        },
        po_user: { id: BUYER, company_id: IDS.companies.A },
      },
    });
    expect(result.instance.status).toBe("PENDING");
    return result.instance.id;
  }
  const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
  const approveQuotes = async (product) => (await httpClient(APPROVER))
    .post(`/api/v1/negotiation/quotes/${product.rfqProductId}/approve`).send({ remarks: "approving" });
  const engineApprove = async (instanceId) => (await httpClient(APPROVER))
    .post("/api/v1/general/hospitality/approval/action")
    .send({ approval_instance_id: instanceId, action: "APPROVE", comment: "approving" });

  /** A parked award of `rfq` whose quote line was swapped for company B's. */
  async function tamperedAward() {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    const rfqB = await makeRfq({ company: "B" });
    const foreign = await addQuote(rfqB, await addProduct(rfqB), ALPHA, 777);
    const instanceId = await parkedAward(rfq, product, line, {
      quote_id: foreign.quoteItemId, quote_item_id: foreign.quoteItemId,
    });
    return { rfq, product, instanceId };
  }

  it("approveQuotes refuses a parked payload with another company's quote line: nothing approved, no PO", async () => {
    const { rfq, product, instanceId } = await tamperedAward();

    const res = await approveQuotes(product);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject(NOT_FOUND);
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await trail(rfq)).toMatchObject({ finalizations: [], pos: [], lines: [] });
  });

  it("the approval engine refuses the same payload before recording the approval", async () => {
    const { rfq, instanceId } = await tamperedAward();

    const res = await engineApprove(instanceId);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "AWARD_QUOTE_NOT_FOUND" });
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instanceId])).toEqual([]);
    expect(await trail(rfq)).toMatchObject({ finalizations: [], pos: [], lines: [] });
  });

  it("approveQuotes refuses a parked payload whose product is not the instance's (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq, { variant: 0 });
    const other = await addProduct(rfq, { variant: 1 });
    const otherLine = await addQuote(rfq, other);
    // Parked on `product`'s approval, but the payload awards `other`.
    const instanceId = await parkedAward(rfq, product, otherLine, {
      variant: other.variant,
      product_info: { ...finalizeBody(rfq, other, otherLine).product_info },
    });

    const res = await approveQuotes(product);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(MISMATCH);
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await trail(rfq)).toMatchObject({ pos: [], lines: [] });
  });

  it("a parked payload that binds is still approved into a PO", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    const instanceId = await parkedAward(rfq, product, line);

    const res = await approveQuotes(product);

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    expect((await trail(rfq)).lines).toHaveLength(1);
  });
});

// ---- submit-for-approval ----------------------------------------------------------

describe("POST /negotiation/quotes/submit-for-approval binds round quotes to the RFQ product", () => {
  it("refuses a negotiation-round quote of another company's RFQ and opens no approval", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    await addQuote(rfq, product);
    const rfqB = await makeRfq({ company: "B" });
    const productB = await addProduct(rfqB);
    await addQuote(rfqB, productB);
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, round_number, end_date, status, created_by, source_type, source_id, rfq_product_id)
       VALUES ($1, 1, (now() AT TIME ZONE 'UTC') - interval '1 hour', 'COMPLETED', $2, 'RFQ', $1, $3)
       RETURNING id`,
      [rfqB.rfqId, OTHER_COMPANY, productB.rfqProductId]
    );
    const foreignRoundQuote = await db.one(
      `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
       VALUES ($1, $2, $3, 77, NOW()) RETURNING id`,
      [round.id, ALPHA, productB.rfqProductId]
    );

    const res = await (await httpClient(BUYER)).post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id: rfq.rfqId, rfq_product_id: product.rfqProductId,
      quote_ids: [foreignRoundQuote.id], quote_source: "negotiation", remarks: "submitting",
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 2, message: "One or more quote IDs are invalid or do not belong to this product" });
    expect(await trail(rfq)).toEqual(NOTHING);
  });
});

// ---- finalize scope -----------------------------------------------------------------

describe("POST /rfq/finalize refuses a same-company buyer outside the RFQ's scope", () => {
  it("another department of the same hotel: 403 and nothing written (the RFQ's own department awards)", async () => {
    const rfq = await makeRfq({ dept: IDS.departments.proc });
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);

    const res = await finalize(ENG_BUYER, finalizeBody(rfq, product, line));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 3, code: "PROCESS_NOT_IN_USER_SCOPE" });
    expect(await trail(rfq)).toEqual(NOTHING);

    expect((await finalize(BUYER, finalizeBody(rfq, product, line))).status).toBe(200);
  });

  it("another hotel of the same company: 403 and nothing written (a buyer on that hotel awards)", async () => {
    const rfq = await makeRfq({ hotel: IDS.hotels.A2, process: null, dept: IDS.departments.proc });
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);

    const res = await finalize(BUYER, finalizeBody(rfq, product, line));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 3, code: "PROCESS_NOT_IN_USER_SCOPE" });
    expect(await trail(rfq)).toEqual(NOTHING);

    expect((await finalize(MULTI_HOTEL, finalizeBody(rfq, product, line))).status).toBe(200);
  });
});

// ---- scope refusal bodies ---------------------------------------------------------------

describe("a scope refusal does not echo the refused record's tenant ids", () => {
  it("another company's buyer is told 403 with no company, hotel, department or process id", async () => {
    const rfq = await makeRfq({ dept: IDS.departments.proc });
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);

    const res = await finalize(OTHER_COMPANY, finalizeBody(rfq, product, line));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      status: 3,
      code: "PROCESS_NOT_IN_USER_SCOPE",
      message: expect.any(String),
    });
    const raw = JSON.stringify(res.body);
    for (const id of [IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]) {
      expect(raw).not.toContain(String(id));
    }
    expect(await trail(rfq)).toEqual(NOTHING);
  });
});
