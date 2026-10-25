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
//   - submit-for-approval only accepts round quotes of this RFQ and product
//     (an older round quote with no product of its own counts as its round's).
//   - a selected_quotes award parked by submit-for-approval is bound again at
//     approval too: an instance parked before the round-quote ids were scoped
//     can carry another company's round quote.
//   - the approval engine binds only for an approver who can act: anyone else
//     gets "not an approver", whether the award binds or not.
//   - an award refused after its approval committed (auto-completion) leaves a
//     NEGOTIATION_QUOTES_APPROVED_NO_PO row on the timeline; no PO line is ever
//     priced from the request body.
//   - finalize refuses a same-company buyer outside the RFQ's hotel or
//     department (403), and no scope refusal echoes the refused record's ids.
//   - an approval instance can not be forged: the generic submit route refuses
//     every server-owned entity type, and an instance that exists anyway is
//     refused by the binders unless its company owns the RFQ it awards.
//   - a selected_quotes award is priced from the vendor's quote line, never
//     from the price parked in metadata.
//   - replaying APPROVE on a concluded approval runs nothing, and a caller from
//     another company is told only what a missing instance would tell them.
//   - a forged instance that does exist (opened before the submit route was
//     closed) changes nothing of the other company's on REJECT either: no
//     finalization reset, no timeline row; a forged legacy NEGOTIATION
//     instance neither activates nor cancels the other company's round.
//   - a parked po_user must be the instance's initiator.
//   - a PO refused after approveQuotes committed the approval (a hold opened
//     as the approval landed) is reported as an approval without a PO and
//     recorded on the timeline with a remark naming the hold; a hold already
//     open is refused before anything is approved.
//
// Real Postgres; every test commits and the afterEach removes what it created.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import { handleAutoCompletedInstances } from "../../app/services/approvalPropagationService.js";
import { buildAuthoritativePOPayload } from "../../app/controllers/po/purchaseOrderController.js";
import { AuthorizationError } from "../../app/services/authorizationService.js";

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
      WHERE ai.entity_type = 'PO' AND po.rfq_id = ANY($1::int[])
     UNION
     SELECT ai.id FROM tbl_approval_instances ai
      WHERE ai.entity_type IN ('NEGOTIATION', 'NEGOTIATION_QUOTE') AND (ai.metadata->>'rfq_id') = ANY($2::text[])`,
    [ids, ids.map(String)]
  );
  const instanceIds = instances.map((r) => r.id);
  await db.none(`DELETE FROM tbl_po_send_backs WHERE rfq_id = ANY($1::int[])`, [ids]);
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

const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const approveQuotes = async (product, userId = APPROVER) => (await httpClient(userId))
  .post(`/api/v1/negotiation/quotes/${product.rfqProductId}/approve`).send({ remarks: "approving" });
const engineApprove = async (instanceId, userId = APPROVER) => (await httpClient(userId))
  .post("/api/v1/general/hospitality/approval/action")
  .send({ approval_instance_id: instanceId, action: "APPROVE", comment: "approving" });
const engineReject = async (instanceId, userId = APPROVER) => (await httpClient(userId))
  .post("/api/v1/general/hospitality/approval/action")
  .send({ approval_instance_id: instanceId, action: "REJECT", comment: "not this vendor" });
/** The first PENDING approver on an instance's current step. */
const pendingApproverOf = async (instanceId) => Number((await db.one(
  `SELECT sa.approver_user_id FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
    WHERE i.id = $1 AND sa.status = 'PENDING' ORDER BY sa.approver_user_id LIMIT 1`, [instanceId])).approver_user_id);

/** A COMPLETED negotiation round on `product` and `vendor`'s quote in it. `legacy`: the quote names no product (older rows). */
async function addRoundQuote(rfq, product, { vendor = ALPHA, price = 300, creator = BUYER, legacy = false } = {}) {
  const round = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, round_number, end_date, status, created_by, source_type, source_id, rfq_product_id)
     VALUES ($1, 1, (now() AT TIME ZONE 'UTC') - interval '1 hour', 'COMPLETED', $2, 'RFQ', $1, $3)
     RETURNING id`,
    [rfq.rfqId, creator, product.rfqProductId]
  );
  const quote = await db.one(
    `INSERT INTO tbl_negotiation_round_quotes (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
    [round.id, vendor, legacy ? null : product.rfqProductId, price]
  );
  return { roundId: Number(round.id), roundQuoteId: Number(quote.id), vendor, price };
}

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

/** A NEGOTIATION_QUOTE approval parked by submit-for-approval for `product`, with these selected_quotes. */
async function parkedSelection(rfq, product, selectedQuotes) {
  const result = await createApprovalInstance({
    entity_type: "NEGOTIATION_QUOTE",
    entity_id: product.rfqProductId,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: null,
    process_id: IDS.processes.A_P1,
    initiated_by: BUYER,
    metadata: {
      rfq_id: rfq.rfqId, rfq_number: rfq.rfqNo, rfq_title: "quote binding fixture",
      rfq_product_id: product.rfqProductId, is_tender: 0,
      selected_quotes: selectedQuotes,
      submitted_at: new Date().toISOString(),
    },
  });
  expect(result.instance.status).toBe("PENDING");
  return result.instance.id;
}

const submitApproval = async (userId, body) => (await httpClient(userId))
  .post("/api/v1/general/hospitality/approval/submit").send(body);

/** Every row an approval of `rfq` can have written, for a before/after comparison. */
const snapshot = async (rfq) => ({
  pos: await db.any(`SELECT id, status, total_value FROM tbl_rfq_purchase_order WHERE rfq_id = $1 ORDER BY id`, [rfq.rfqId]),
  lines: await db.any(
    `SELECT l.id, l.purchase_order_id, l.unit_price, l.quantity FROM tbl_purchase_order_product l
       JOIN tbl_rfq_purchase_order po ON po.id = l.purchase_order_id WHERE po.rfq_id = $1 ORDER BY l.id`,
    [rfq.rfqId]
  ),
  finalizations: await db.any(`SELECT id, vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1 ORDER BY id`, [rfq.rfqId]),
  lifecycle: await db.any(`SELECT id, stage FROM tbl_lifecycle_history WHERE entity_id = $1 AND entity_type IN ('RFQ', 'TENDER') ORDER BY id`, [rfq.rfqId]),
});

/** The unit price of each PO line drafted on `rfq`, by RFQ product. */
const lineUnitPrices = async (rfq) => (await db.any(
  `SELECT l.rfq_product_id, l.unit_price FROM tbl_purchase_order_product l
     JOIN tbl_rfq_purchase_order po ON po.id = l.purchase_order_id
    WHERE po.rfq_id = $1 ORDER BY l.rfq_product_id, l.id`,
  [rfq.rfqId]
)).map((r) => ({ rfqProductId: Number(r.rfq_product_id), unitPrice: Number(r.unit_price) }));

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

  it("answers an unknown quote line id with exactly the body it gives another company's", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const own = await addQuote(rfq, product);
    const rfqB = await makeRfq({ company: "B" });
    const foreign = await addQuote(rfqB, await addProduct(rfqB), ALPHA, 777);
    const { unknown } = await db.one(`SELECT COALESCE(MAX(id), 0) + 100000 AS unknown FROM tbl_quote_items`);

    const foreignRes = await finalize(BUYER, finalizeBody(rfq, product, own, {
      quote_id: foreign.quoteId, quote_item_id: foreign.quoteItemId,
    }));
    const unknownRes = await finalize(BUYER, finalizeBody(rfq, product, own, {
      quote_id: Number(unknown), quote_item_id: Number(unknown),
    }));

    expect(unknownRes.status).toBe(foreignRes.status);
    expect(unknownRes.body).toEqual(foreignRes.body);
    expect(foreignRes.body).toMatchObject(NOT_FOUND);
    expect(await trail(rfq)).toEqual(NOTHING);
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

  it("refuses a parked payload whose po_user is not the user who opened the approval, on both surfaces (400)", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    const instanceId = await parkedAward(rfq, product, line);
    // finalize parks po_user = the finalizing user = the initiator; this one
    // was rewritten to draft the PO in someone else's name.
    await db.none(
      `UPDATE tbl_approval_instances SET metadata = jsonb_set(metadata, '{po_user,id}', to_jsonb($2::int)) WHERE id = $1`,
      [instanceId, APPROVER]
    );

    const viaApproveQuotes = await approveQuotes(product);
    const viaEngine = await engineApprove(instanceId);

    expect(viaApproveQuotes.status).toBe(400);
    expect(viaApproveQuotes.body).toMatchObject(MISMATCH);
    expect(viaEngine.status).toBe(400);
    expect(viaEngine.body).toMatchObject({ code: "AWARD_QUOTE_MISMATCH" });
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await trail(rfq)).toMatchObject({ finalizations: [], pos: [], lines: [] });
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

  it("the engine tells a caller from another company only that the instance does not exist, whether the payload binds or not", async () => {
    const tampered = await tamperedAward();
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const bound = await parkedAward(rfq, product, await addQuote(rfq, product));

    const onTampered = await engineApprove(tampered.instanceId, OTHER_COMPANY);
    const onBound = await engineApprove(bound, OTHER_COMPANY);

    // Another company's instance answers exactly like one that does not exist.
    const { missing } = await db.one(`SELECT COALESCE(MAX(id), 0) + 100000 AS missing FROM tbl_approval_instances`);
    const onMissing = await engineApprove(Number(missing), OTHER_COMPANY);
    expect(onTampered.status).toBe(404);
    expect(onTampered.body).toEqual({ status: 2, message: "Approval instance not found" });
    expect(onBound.status).toBe(onTampered.status);
    expect(onBound.body).toEqual(onTampered.body);
    expect(onMissing.status).toBe(onTampered.status);
    expect(onMissing.body).toEqual(onTampered.body);
    expect(await instanceStatus(tampered.instanceId)).toBe("PENDING");
    expect(await instanceStatus(bound)).toBe("PENDING");
  });

  it("a payload refused after its approval auto-completed drafts nothing and says so on the RFQ timeline", async () => {
    const { rfq, instanceId } = await tamperedAward();
    // approvalPropagationService completes an instance whose remaining steps
    // a policy or membership change emptied, then runs the post-approval
    // handler: no approval surface (and so no pre-flight) is involved.
    await db.none(`UPDATE tbl_approval_instances SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`, [instanceId]);

    await handleAutoCompletedInstances([instanceId], APPROVER, "policy change");

    expect(await trail(rfq)).toMatchObject({ finalizations: [], pos: [], lines: [] });
    const events = await db.any(
      `SELECT entity_type, stage, metadata FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'NEGOTIATION_QUOTES_APPROVED_NO_PO'`,
      [rfq.rfqId]
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity_type: "RFQ",
      metadata: { approval_instance_id: instanceId, reason: "AWARD_QUOTE_NOT_FOUND" },
    });
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

describe("a legitimate negotiation-round award still goes through submit and approval", () => {
  it("accepts this product's round quotes, including an older one that names no product, and awards the vendor", async () => {
    const rfq = await makeRfq();
    const current = await addProduct(rfq, { variant: 0 });
    const legacyProduct = await addProduct(rfq, { variant: 1 });
    await addQuote(rfq, current, ALPHA, 100);
    await addQuote(rfq, legacyProduct, ALPHA, 100);
    const currentQuote = await addRoundQuote(rfq, current);
    const legacyQuote = await addRoundQuote(rfq, legacyProduct, { legacy: true });
    const submit = async (product, roundQuote) => (await httpClient(BUYER))
      .post("/api/v1/negotiation/quotes/submit-for-approval").send({
        rfq_id: rfq.rfqId, rfq_product_id: product.rfqProductId,
        quote_ids: [roundQuote.roundQuoteId], quote_source: "negotiation", remarks: "submitting",
      });

    const currentRes = await submit(current, currentQuote);
    const legacyRes = await submit(legacyProduct, legacyQuote);

    for (const res of [currentRes, legacyRes]) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.status).toBe("PENDING");
    }
    const approved = await approveQuotes(legacyProduct);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe(1);
    expect(await instanceStatus(legacyRes.body.data.approval_instance_id)).toBe("APPROVED");
    const fin = await db.any(
      `SELECT vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1 AND variant = $2`,
      [rfq.rfqId, legacyProduct.variant]
    );
    expect(fin).toEqual([{ vendor_id: ALPHA, quote_id: legacyQuote.roundQuoteId }]);
    expect((await trail(rfq)).lines).toHaveLength(1);
  });
});

describe("a selected_quotes award parked before submit was scoped is bound again at approval", () => {
  /** Company B's completed round on its own RFQ, with ALPHA's quote at 777. */
  async function foreignRoundQuote() {
    const rfqB = await makeRfq({ company: "B" });
    const productB = await addProduct(rfqB);
    return addRoundQuote(rfqB, productB, { price: 777, creator: OTHER_COMPANY });
  }
  const entry = (quoteId, extra = {}) => ({
    quote_id: quoteId, vendor_id: ALPHA, vendor_name: "Alpha", quoted_price: 777, submitted_at: null, ...extra,
  });

  it("approveQuotes refuses another company's round quote: nothing approved, nothing awarded", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    await addQuote(rfq, product);
    const foreign = await foreignRoundQuote();
    const instanceId = await parkedSelection(rfq, product, [
      entry(foreign.roundQuoteId, { negotiation_round_id: foreign.roundId }),
    ]);

    const res = await approveQuotes(product);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject(NOT_FOUND);
    expect(JSON.stringify(res.body)).not.toContain("777");
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instanceId])).toEqual([]);
    expect(await trail(rfq)).toMatchObject({ finalizations: [], pos: [], lines: [] });
  });

  it("the approval engine refuses it too, before recording the approval", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const foreign = await foreignRoundQuote();
    const instanceId = await parkedSelection(rfq, product, [
      entry(foreign.roundQuoteId, { negotiation_round_id: foreign.roundId }),
    ]);

    const res = await engineApprove(instanceId);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "AWARD_QUOTE_NOT_FOUND" });
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await db.any(`SELECT id FROM tbl_approval_actions WHERE approval_instance_id = $1`, [instanceId])).toEqual([]);
  });

  it("refuses a regular-quote entry that is another company's quote, and a round quote of this product by another vendor", async () => {
    // Regular-sourced: no negotiation_round_id, names company B's tbl_quotes row.
    const rfq1 = await makeRfq();
    const product1 = await addProduct(rfq1);
    await addQuote(rfq1, product1);
    const rfqB = await makeRfq({ company: "B" });
    const foreignQuote = await addQuote(rfqB, await addProduct(rfqB), ALPHA, 777);
    const regular = await parkedSelection(rfq1, product1, [entry(foreignQuote.quoteId)]);
    // Round-sourced on this very product, but BETA's quote, awarded to ALPHA.
    const rfq2 = await makeRfq();
    const product2 = await addProduct(rfq2);
    await addQuote(rfq2, product2);
    const betaRound = await addRoundQuote(rfq2, product2, { vendor: BETA });
    const otherVendor = await parkedSelection(rfq2, product2, [
      entry(betaRound.roundQuoteId, { negotiation_round_id: betaRound.roundId }),
    ]);

    const regularRes = await approveQuotes(product1);
    const otherVendorRes = await approveQuotes(product2);

    for (const res of [regularRes, otherVendorRes]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject(NOT_FOUND);
    }
    expect(await instanceStatus(regular)).toBe("PENDING");
    expect(await instanceStatus(otherVendor)).toBe("PENDING");
    expect(await trail(rfq1)).toMatchObject({ finalizations: [], pos: [], lines: [] });
    expect(await trail(rfq2)).toMatchObject({ finalizations: [], pos: [], lines: [] });
  });

  it("still approves a regular-quote selection of this product's own quote", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const own = await addQuote(rfq, product);
    const instanceId = await parkedSelection(rfq, product, [entry(own.quoteId, { quoted_price: 300 })]);

    const res = await approveQuotes(product);

    expect(res.status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    const fin = await db.any(`SELECT vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfqId]);
    expect(fin).toEqual([{ vendor_id: ALPHA, quote_id: own.quoteId }]);
  });
});

describe("no PO line is priced from the request body", () => {
  it("a quote line gone after binding, or a failed pricing read, throws instead of returning the payload", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product, ALPHA, 100);
    const payload = { ...finalizeBody(rfq, product, line), quote_id: line.quoteItemId };
    payload.product_info = { ...payload.product_info, unit_price: 1 };
    // The binding read reaches the database; the pricing read after it gets `second`.
    const ctx = (second) => {
      let reads = 0;
      return { oneOrNone: (...args) => (++reads === 1 ? db.oneOrNone(...args) : second()) };
    };

    await expect(buildAuthoritativePOPayload(payload, ctx(async () => null)))
      .rejects.toMatchObject({ code: "AWARD_QUOTE_NOT_FOUND" });
    await expect(buildAuthoritativePOPayload(payload, ctx(async () => { throw new Error("connection reset"); })))
      .rejects.toThrow("connection reset");
    const priced = await buildAuthoritativePOPayload(payload, db);
    expect(Number(priced.product_info.unit_price)).toBe(100);
  });
});

// ---- forged approval instances --------------------------------------------------------

describe("an award approval can not be forged", () => {
  /** Company B's product and quote line, and a self-consistent finalize payload for it. */
  async function foreignAward() {
    const rfqB = await makeRfq({ company: "B" });
    const productB = await addProduct(rfqB);
    const lineB = await addQuote(rfqB, productB, ALPHA, 777);
    const metadata = {
      rfq_id: rfqB.rfqId, rfq_number: rfqB.rfqNo, rfq_product_id: productB.rfqProductId, is_tender: 0,
      vendor_id: ALPHA, quote_id: lineB.quoteId, quote_item_id: lineB.quoteItemId,
      po_payload: { ...finalizeBody(rfqB, productB, lineB), quote_id: lineB.quoteItemId },
      po_user: { id: BUYER, company_id: IDS.companies.A },
    };
    return { rfqB, productB, lineB, metadata };
  }

  it("POST /approval/submit refuses a NEGOTIATION_QUOTE forged on another company's product, and every other server-owned type", async () => {
    const { rfqB, productB, metadata } = await foreignAward();
    const forged = {
      entity_type: "NEGOTIATION_QUOTE", entity_id: productB.rfqProductId,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, process_id: IDS.processes.A_P1, metadata,
    };
    const { n: before } = await db.one(`SELECT count(*)::int AS n FROM tbl_approval_instances`);

    const res = await submitApproval(BUYER, forged);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 3, code: "APPROVAL_TYPE_SERVER_OWNED" });
    for (const entity_type of [
      "RFQ", "TENDER", "TECHNICAL", "NEGOTIATION", "PO", "ARC", "ARC_PUBLISH", "ARC_TECH",
      "ARC_COMMITTEE", "ARC_NEGOTIATION", "ARC_AMENDMENT", "MR", "negotiation_quote",
    ]) {
      const other = await submitApproval(BUYER, { ...forged, entity_type, metadata: {} });
      expect({ entity_type, status: other.status, code: other.body.code })
        .toEqual({ entity_type, status: 403, code: "APPROVAL_TYPE_SERVER_OWNED" });
    }
    const { n: after } = await db.one(`SELECT count(*)::int AS n FROM tbl_approval_instances`);
    expect(after).toBe(before);
    expect(await trail(rfqB)).toEqual(NOTHING);
  });

  it("a forged instance already in the database is refused: its company does not own the RFQ it awards", async () => {
    const { rfqB, productB, metadata } = await foreignAward();
    // Company A's instance, company A's approver, company B's product and quote line.
    const result = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE", entity_id: productB.rfqProductId,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: BUYER, metadata,
    });
    const instanceId = result.instance.id;
    expect(result.instance.status).toBe("PENDING");

    const viaApproveQuotes = await approveQuotes(productB);
    const viaEngine = await engineApprove(instanceId);

    expect(viaApproveQuotes.status).toBe(404);
    expect(viaApproveQuotes.body).toMatchObject(NOT_FOUND);
    expect(viaEngine.status).toBe(404);
    expect(viaEngine.body).toMatchObject({ code: "AWARD_QUOTE_NOT_FOUND" });
    expect(JSON.stringify([viaApproveQuotes.body, viaEngine.body])).not.toContain("777");
    expect(await instanceStatus(instanceId)).toBe("PENDING");
    expect(await snapshot(rfqB)).toEqual({ pos: [], lines: [], finalizations: [], lifecycle: [] });

    // Completed without either surface (approvalPropagationService): still no
    // PO on B's RFQ, and nothing written to B's timeline either.
    await db.none(`UPDATE tbl_approval_instances SET status = 'APPROVED', completed_at = NOW() WHERE id = $1`, [instanceId]);
    await handleAutoCompletedInstances([instanceId], APPROVER, "policy change");
    expect(await snapshot(rfqB)).toEqual({ pos: [], lines: [], finalizations: [], lifecycle: [] });
  });

  it("rejecting a forged instance resets nothing and writes nothing on the other company's RFQ", async () => {
    const { rfqB, productB, lineB, metadata } = await foreignAward();
    // Company B has awarded its product to ALPHA.
    await db.none(
      `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant, "timestamp")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [rfqB.rfqId, rfqB.rfqNo, VARIANT, ALPHA, lineB.quoteId, OTHER_COMPANY, productB.variant]
    );
    const before = await snapshot(rfqB);
    expect(before.finalizations).toHaveLength(1);
    // A forged instance (company A, company B's product and RFQ), rejected by A's approver.
    const result = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE", entity_id: productB.rfqProductId,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: BUYER, metadata,
    });

    const res = await engineReject(result.instance.id);

    expect(res.status).toBe(200);
    expect(await instanceStatus(result.instance.id)).toBe("REJECTED");
    expect(await snapshot(rfqB)).toEqual(before);
    expect(await db.any(`SELECT id FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [rfqB.rfqId])).toEqual([]);
  });

  it("a forged legacy NEGOTIATION instance neither activates nor cancels the other company's round", async () => {
    const rfqB = await makeRfq({ company: "B" });
    const productB = await addProduct(rfqB);
    const roundB = async (roundNumber) => db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, round_number, end_date, status, created_by, source_type, source_id, rfq_product_id,
          vendor_ids, vendor_approvals)
       VALUES ($1, $6, (now() AT TIME ZONE 'UTC') + interval '2 days', 'PENDING_APPROVAL', $2, 'RFQ', $1, $3,
               ARRAY[$4]::int[], $5::jsonb)
       RETURNING id`,
      [rfqB.rfqId, OTHER_COMPANY, productB.rfqProductId, ALPHA,
        JSON.stringify([{ vendor_id: ALPHA, status: "PENDING" }]), roundNumber]
    ).then((r) => Number(r.id));
    const roundState = async (id) => db.one(
      `SELECT status, approved_at, published_at, vendor_approvals FROM tbl_negotiation_rounds WHERE id = $1`, [id]);
    /** Company A's NEGOTIATION instance naming company B's round. */
    const forgedOn = async (roundId) => (await createApprovalInstance({
      entity_type: "NEGOTIATION", entity_id: roundId,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: BUYER,
      metadata: { round_id: roundId, rfq_id: rfqB.rfqId, rfq_product_id: productB.rfqProductId, round_number: 1 },
    })).instance.id;

    const toApprove = await roundB(1);
    const toReject = await roundB(2);
    const beforeApprove = await roundState(toApprove);
    const beforeReject = await roundState(toReject);
    const approving = await forgedOn(toApprove);
    const rejecting = await forgedOn(toReject);

    const approved = await engineApprove(approving, await pendingApproverOf(approving));
    const rejected = await engineReject(rejecting, await pendingApproverOf(rejecting));

    expect(approved.status).toBe(200);
    expect(rejected.status).toBe(200);
    expect(await instanceStatus(approving)).toBe("APPROVED");
    expect(await instanceStatus(rejecting)).toBe("REJECTED");
    expect(await roundState(toApprove)).toEqual(beforeApprove);
    expect(await roundState(toReject)).toEqual(beforeReject);
    expect((await snapshot(rfqB)).lifecycle).toEqual([]);
  });

  it("prices a selected_quotes award from the vendor's quote line, never from the price parked in metadata", async () => {
    const rfq = await makeRfq();
    const regular = await addProduct(rfq, { variant: 0 });
    const fromRound = await addProduct(rfq, { variant: 1 });
    const own = await addQuote(rfq, regular, ALPHA, 100);
    await addQuote(rfq, fromRound, ALPHA, 100);
    // A round quote's quoted_price is the landed LINE total (3 x 100), not a unit price.
    const roundQuote = await addRoundQuote(rfq, fromRound, { price: 300 });
    await parkedSelection(rfq, regular, [
      { quote_id: own.quoteId, vendor_id: ALPHA, vendor_name: "Alpha", quoted_price: 1, submitted_at: null },
    ]);
    await parkedSelection(rfq, fromRound, [{
      quote_id: roundQuote.roundQuoteId, vendor_id: ALPHA, vendor_name: "Alpha", quoted_price: 300,
      negotiation_round_id: roundQuote.roundId, submitted_at: null,
    }]);

    expect((await approveQuotes(regular)).status).toBe(200);
    expect((await approveQuotes(fromRound)).status).toBe(200);

    expect(await lineUnitPrices(rfq)).toEqual([
      { rfqProductId: regular.rfqProductId, unitPrice: 100 },
      { rfqProductId: fromRound.rfqProductId, unitPrice: 100 },
    ]);
  });
});

// ---- replaying a concluded approval ------------------------------------------------------

describe("APPROVE replayed on a concluded approval runs nothing", () => {
  it("another company's admin is told the instance does not exist; same-company callers change nothing", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    const instanceId = await parkedAward(rfq, product, line);
    expect((await approveQuotes(product)).status).toBe(200);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
    const before = await snapshot(rfq);
    expect(before.lines).toHaveLength(1);

    const foreign = await engineApprove(instanceId, OTHER_COMPANY);
    const { missing } = await db.one(`SELECT COALESCE(MAX(id), 0) + 100000 AS missing FROM tbl_approval_instances`);
    const nonexistent = await engineApprove(Number(missing), OTHER_COMPANY);

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(nonexistent.body);
    expect(foreign.status).toBe(nonexistent.status);
    expect(await snapshot(rfq)).toEqual(before);

    for (const sameCompany of [BUYER, APPROVER]) {
      const replay = await engineApprove(instanceId, sameCompany);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ already_completed: true, instance_status: "APPROVED" });
    }
    expect(await snapshot(rfq)).toEqual(before);
    expect(await instanceStatus(instanceId)).toBe("APPROVED");
  });
});

// ---- a PO refused after approveQuotes committed ------------------------------------------

describe("approveQuotes when the PO is refused after the approval committed", () => {
  // The approval checks the product's PO is not on hold before it commits
  // (409, nothing approved). A hold opened by someone else between that commit
  // and the draft is the case left: the draft refuses it under the PO lock,
  // after the instance is APPROVED. The trigger below is that other writer,
  // opening the hold in the same instant the approval lands.
  const holdOnApproval = async ({ instanceId, poId, rfqId, holdInstanceId }) => {
    await db.none(`
      CREATE OR REPLACE FUNCTION sec1_hold_on_approval() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO tbl_po_send_backs
          (purchase_order_id, rfq_id, approval_instance_id, step_order, route, reason_category, comment, requested_by)
        VALUES (${Number(poId)}, ${Number(rfqId)}, ${Number(holdInstanceId)}, 1, 'COMMERCIAL', 'OTHER', 'checking the rate', ${Number(APPROVER)});
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql`);
    await db.none(`
      CREATE TRIGGER sec1_hold_on_approval AFTER UPDATE OF status ON tbl_approval_instances
      FOR EACH ROW WHEN (NEW.id = ${Number(instanceId)} AND NEW.status = 'APPROVED')
      EXECUTE FUNCTION sec1_hold_on_approval()`);
  };
  const dropHoldOnApproval = async () => {
    await db.none(`DROP TRIGGER IF EXISTS sec1_hold_on_approval ON tbl_approval_instances`);
    await db.none(`DROP FUNCTION IF EXISTS sec1_hold_on_approval()`);
  };
  afterEach(dropHoldOnApproval);

  it("says the approval stands with no PO, and records why on the timeline", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    // A first award, approved into a PO that is then sent for approval.
    const first = await parkedAward(rfq, product, line);
    expect((await approveQuotes(product)).status).toBe(200);
    const po = await db.one(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId]);
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [po.id]);
    // A second award of the same product; its PO is put on hold as the
    // approval commits, so the draft that follows refuses (PO_ON_HOLD).
    const second = await parkedAward(rfq, product, line);
    await holdOnApproval({ instanceId: second, poId: po.id, rfqId: rfq.rfqId, holdInstanceId: first });

    const res = await approveQuotes(product);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.message).toMatch(/no purchase order was drafted/i);
    expect(res.body.data).toMatchObject({ approved: true, fully_approved: true, po_not_drafted: { code: "PO_ON_HOLD" } });
    expect(await instanceStatus(second)).toBe("APPROVED");
    expect(await db.any(`SELECT id, status FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId]))
      .toEqual([{ id: po.id, status: "pending_approval" }]);
    const events = await db.any(
      `SELECT metadata, remarks FROM tbl_lifecycle_history
        WHERE entity_id = $1 AND stage = 'NEGOTIATION_QUOTES_APPROVED_NO_PO'`,
      [rfq.rfqId]
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ approval_instance_id: second, reason: "PO_ON_HOLD" });
    expect(events[0].remarks).toMatch(/on hold/i);
    expect(events[0].remarks).not.toMatch(/does not match/i);
  });

  it("a hold already open when the approver acts is refused before anything is approved", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product);
    const first = await parkedAward(rfq, product, line);
    expect((await approveQuotes(product)).status).toBe(200);
    const po = await db.one(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfqId]);
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [po.id]);
    await db.none(
      `INSERT INTO tbl_po_send_backs
         (purchase_order_id, rfq_id, approval_instance_id, step_order, route, reason_category, comment, requested_by)
       VALUES ($1, $2, $3, 1, 'COMMERCIAL', 'OTHER', 'checking the rate', $4)`,
      [po.id, rfq.rfqId, first, APPROVER]
    );
    const second = await parkedAward(rfq, product, line);

    const res = await approveQuotes(product);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 0, code: "PO_ON_HOLD" });
    expect(await instanceStatus(second)).toBe("PENDING");
    expect(await db.any(
      `SELECT 1 FROM tbl_lifecycle_history WHERE entity_id = $1 AND stage = 'NEGOTIATION_QUOTES_APPROVED_NO_PO'`,
      [rfq.rfqId]
    )).toHaveLength(0);
  });
});

// ---- the legitimate ways in ---------------------------------------------------------------

describe("the legitimate ways an award approval is opened still work", () => {
  it("finalize parks the award and its approver approves it through the engine into a PO priced from the quote", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const line = await addQuote(rfq, product, ALPHA, 100);
    const body = finalizeBody(rfq, product, line);
    body.product_info = { ...body.product_info, unit_price: 1 };

    const res = await finalize(BUYER, body);

    expect(res.status).toBe(200);
    const { approvals } = await trail(rfq);
    expect(approvals).toHaveLength(1);
    expect(await instanceStatus(approvals[0].id)).toBe("PENDING");
    expect((await engineApprove(approvals[0].id)).status).toBe(200);
    expect(await instanceStatus(approvals[0].id)).toBe("APPROVED");
    expect(await lineUnitPrices(rfq)).toEqual([{ rfqProductId: product.rfqProductId, unitPrice: 100 }]);
  });

  it("submit-for-approval of a vendor's quote is approved into a PO priced from the quote", async () => {
    const rfq = await makeRfq();
    const product = await addProduct(rfq);
    const own = await addQuote(rfq, product, ALPHA, 100);

    const submitted = await (await httpClient(BUYER)).post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id: rfq.rfqId, rfq_product_id: product.rfqProductId,
      quote_ids: [own.quoteId], quote_source: "regular", remarks: "submitting",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe("PENDING");

    const approved = await approveQuotes(product);

    expect(approved.status).toBe(200);
    expect(await instanceStatus(submitted.body.data.approval_instance_id)).toBe("APPROVED");
    const fin = await db.any(`SELECT vendor_id, quote_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfqId]);
    expect(fin).toEqual([{ vendor_id: ALPHA, quote_id: own.quoteId }]);
    expect(await lineUnitPrices(rfq)).toEqual([{ rfqProductId: product.rfqProductId, unitPrice: 100 }]);
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

  it("an AuthorizationError serialized by a generic catch carries no scope tuple", () => {
    const err = new AuthorizationError("Not in your scope", { hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1 });

    const body = JSON.parse(JSON.stringify({ status: 3, error: err }));

    expect(body.error).toEqual({
      name: "AuthorizationError", code: "PROCESS_NOT_IN_USER_SCOPE", status: 403, message: "Not in your scope",
    });
    expect(err.data.hotel_id).toBe(IDS.hotels.A1); // still there for code that reads it
  });
});
