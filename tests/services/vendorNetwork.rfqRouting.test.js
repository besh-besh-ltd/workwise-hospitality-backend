// Vendor Networks: the RFQ routing subject and the quote gates (spec §6.3, §10.4, §10.8).
// Pattern B: committed fixtures (vendor ids 95951..95969), removed in afterEach. Every
// endpoint over HTTP (routing API, POST /rfq/quote/create, PUT /rfq/quote/update/:id,
// GET /rfq/getRfqById/:id, GET /rfq/get-quotes/:id, POST /rfq/finalize); the sweep
// through cronManager.runVendorRoutingSweepTick.
//
// SMTP: nodemailer.createTransport is swapped for a no-op recorder.

import nodemailer from "nodemailer";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { grantVendorHotelSubs, grantVendorCategorySub } from "../helpers/arcGroupSeed.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { countQueries } from "../helpers/queryCounter.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { runVendorRoutingSweepTick } from "../../app/helper/cronManager.js";
import {
  getSubjectHandler,
  revokeLiveAssignmentsForEntity,
} from "../../app/services/vendorNetwork/routingEngine.js";
import { rfqSubjectHandler, assertOrgMayQuote } from "../../app/services/vendorNetwork/subjects/rfqSubject.js";
import rfqModel from "../../app/models/rfqModel.js";
import { lockRoutingSubject, getAssignment, releaseAssignment } from "../../app/models/vendorRoutingModel.js";
import {
  propagateRoutedCopies,
  propagateRoutedCopiesLocked,
} from "../../app/services/vendorNetwork/subjects/rfqRoutedCopies.js";

const HQ = 95951; // principal of ORG_A
const B = 95952; // BRANCH of ORG_A
const C = 95953; // BRANCH of ORG_A (sibling of B)
const MP = 95955; // type-11 person, ENTITY_MEMBER of B
const FHQ = 95956; // principal of ORG_F
const FB = 95957; // BRANCH of ORG_F
const NO = 95958; // vendor in no network
const ORG_A = 95951;
const ORG_F = 95952;
const BUYER = IDS.users.a1_proc_buyer;
const BASE = "/api/v1/vendor-network";
const HOUR = 3600 * 1000;

let VARIANT;
let VARIANT2;
let VARIANT_CAT;
const CAT = TEST_CATEGORIES.beverages;
let buyerTypeBefore;
const rfqIds = [];
const hierarchyIds = [];

// --- SMTP no-op ----------------------------------------------------------------------
let realTransport;
beforeAll(async () => {
  realTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(_mail, cb) {
      const info = { messageId: "<vn-rfq>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
  [VARIANT, VARIANT2] = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`)).map((r) => r.id);
  VARIANT_CAT = (
    await db.one(
      `SELECT pv.id FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pc.category_id = $1 AND pv.id NOT IN ($2, $3)
        ORDER BY pv.id LIMIT 1`,
      [CAT, VARIANT, VARIANT2]
    )
  ).id;
  buyerTypeBefore = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [BUYER])).user_type;
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
});

beforeEach(async () => {
  rfqIds.length = 0;
  await world();
});

afterEach(async () => {
  await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id BETWEEN 95951 AND 95969`);
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id BETWEEN 95951 AND 95969`);
  await cleanupRfqs();
  await cleanupVendorNetworkFixtures();
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [BUYER, buyerTypeBefore]);
  nodemailer.createTransport = realTransport;
  await closeDb();
});

async function world() {
  for (const id of [HQ, B, C, FHQ, FB, NO]) {
    await seedVendorEntity({ id, companyId: id, name: `VN RFQ ${id}`, email: `vn-rfq-${id}@example.com` });
  }
  await seedOrg({ id: ORG_A, principalVendorId: HQ, name: "Org A Network" });
  await addEntity({ orgId: ORG_A, vendorId: B });
  await addEntity({ orgId: ORG_A, vendorId: C });
  await seedPerson({ id: MP, email: "vn-rfq-member@example.com", name: "Mia Member" });
  await addMember({ orgId: ORG_A, personId: MP, entityVendorId: B, role: "ENTITY_MEMBER" });
  await seedOrg({ id: ORG_F, principalVendorId: FHQ, name: "Org F Network" });
  await addEntity({ orgId: ORG_F, vendorId: FB });
}

async function cleanupRfqs() {
  if (!rfqIds.length) return;
  const ids = rfqIds;
  const productIds = (await db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids])).map((r) => r.id);
  const instances = (
    await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE (entity_type IN ('NEGOTIATION_QUOTE', 'ARC') AND entity_id = ANY($1::int[]))
           OR (entity_type = 'RFQ' AND entity_id = ANY($2::int[]))`,
      [productIds, ids]
    )
  ).map((r) => r.id);
  if (instances.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instances]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [instances]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instances]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instances]);
  }
  if (hierarchyIds.length) {
    await db.none(`DELETE FROM tbl_approval_hierarchy WHERE id = ANY($1::int[])`, [hierarchyIds]);
    hierarchyIds.length = 0;
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id BETWEEN 95951 AND 95969`);
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
}

// --- helpers -----------------------------------------------------------------------------

/** "YYYY-MM-DD HH:mm:ss" IST wall clock `offsetMs` from now: how bid_end_date is stored. */
const istString = (offsetMs) =>
  new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
const utcString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

/** A published RFQ open for 3 days, one product, invited: HQ, FHQ and NO (principal rows). */
async function openRfq({ bidEndOffsetMs = 3 * 24 * HOUR, invite = [HQ, FHQ, NO] } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: utcString(-2 * 24 * HOUR),
    vendor_clarification_date: utcString(-24 * HOUR),
    bid_end_date: istString(bidEndOffsetMs),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    title: "VN routed RFQ",
  });
  rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)`,
    [rfq_id, VARIANT]
  );
  // Quantity + Unit: mandatory per product for the Edit RFQ flow
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
    [rfq_id, VARIANT]
  );
  for (const v of invite) {
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
      [rfq_id, VARIANT, v]
    );
  }
  return { rfq_id, rfq_no };
}

const quoteBody = ({ rfq_id, rfq_no }, { regret = false, price = 100, variants = [VARIANT] } = {}) => ({
  rfq_id,
  rfq_no,
  status: 1,
  products: variants.map((productId) => (
    {
      product_id: productId,
      product_name: "VN product",
      unit_price: regret ? "" : price,
      tax: 18,
      total_price: 0,
      comment: "",
      delivery_period: "7",
      quantity: "10",
      variant: 0,
      tax_mode: "percentage",
      other_charges: [],
      document_files: [],
    }
  )),
  globalPaymentTerms: "",
  globalComment: "",
  global_payment_term_list: [],
  term_and_condition_files: [],
  vendorGSTIN: "",
  global_charges: [],
  ...(regret ? { is_regret: 1, regret_reason: "No stock" } : {}),
});

async function createQuote(userId, rfq, opts) {
  return (await httpClient(userId)).post("/api/v1/rfq/quote/create").send(quoteBody(rfq, opts));
}
const assign = async (rfqId, assignee, actor = HQ) =>
  (await httpClient(actor)).post(`${BASE}/routing/assign`).send({ subject_type: "RFQ", subject_id: rfqId, assignee_vendor_id: assignee });
const respond = async (userId, id, body) => (await httpClient(userId)).post(`${BASE}/routing/${id}/respond`).send(body);
const revoke = async (id, actor = HQ) => (await httpClient(actor)).post(`${BASE}/routing/${id}/revoke`).send({});
const vendorGet = async (userId, rfqId) => (await httpClient(userId)).get(`/api/v1/rfq/getRfqById/${rfqId}`);

const quotesOf = (rfqId) =>
  db.any(`SELECT created_by, is_regret FROM tbl_quotes WHERE rfq_id = $1 ORDER BY id`, [rfqId]);
const rowsOf = (rfqId, userId) =>
  db.any(
    `SELECT user_id, routed_from_vendor_id, product_variant_id, variant FROM tbl_rfq_product_vendors
      WHERE rfq_id = $1 AND user_id = $2 ORDER BY id`,
    [rfqId, userId]
  );
const assignment = (id) => db.one(`SELECT * FROM tbl_vendor_routing_assignments WHERE id = $1`, [id]);

/** Routes `rfq` to `member` and has it accept; returns the assignment id. */
async function routeAndAccept(rfqId, member = B, admin = HQ) {
  const a = await assign(rfqId, member, admin);
  expect(a.status).toBe(201);
  const r = await respond(member, a.body.data.id, { decision: "ACCEPT" });
  expect(r.status).toBe(200);
  return a.body.data.id;
}

/** The first value under `key` anywhere in a JSON body (depth-first), or undefined. */
function findKey(node, key) {
  if (!node || typeof node !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(node, key) && node[key] != null) return node[key];
  for (const v of Object.values(node)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// --- tests -------------------------------------------------------------------------------

describe("routing an RFQ invite to a member", () => {
  it("1. PENDING: the member can GET the RFQ (copied invite rows) but createQuote → 403 ROUTING_REQUIRED", async () => {
    const rfq = await openRfq();
    const a = await assign(rfq.rfq_id, B);
    expect(a.status).toBe(201);

    expect(await rowsOf(rfq.rfq_id, B)).toEqual([
      { user_id: B, routed_from_vendor_id: HQ, product_variant_id: VARIANT, variant: 0 },
    ]);
    const get = await vendorGet(B, rfq.rfq_id);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(rfq.rfq_id);

    const res = await createQuote(B, rfq);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 0, reason: "ROUTING_REQUIRED" });
    // the person acting for B gets the same answer
    expect((await createQuote(MP, rfq)).body.reason).toBe("ROUTING_REQUIRED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });

  it("2. ACCEPTED: the member quotes as itself (created_by = member) and the principal is blocked (409 ROUTED_TO_MEMBER)", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);

    const res = await createQuote(MP, rfq); // a person acting for B
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: B, is_regret: 0 }]);

    const hq = await createQuote(HQ, rfq);
    expect(hq.status).toBe(409);
    expect(hq.body.reason).toBe("ROUTED_TO_MEMBER");
    expect(await quotesOf(rfq.rfq_id)).toHaveLength(1);
  });

  it("2b. a principal regret while a member holds ACCEPTED is refused too (regret writes a quote row)", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const res = await createQuote(HQ, rfq, { regret: true });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("ROUTED_TO_MEMBER");
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });
});

describe("one quote per org", () => {
  it("3a. principal quoted while the member was PENDING → the member's accept is refused (409 ORG_ALREADY_QUOTED), and re-routing too", async () => {
    const rfq = await openRfq();
    const a = await assign(rfq.rfq_id, B);
    expect((await createQuote(HQ, rfq)).status).toBe(200);

    const acc = await respond(B, a.body.data.id, { decision: "ACCEPT" });
    expect(acc.status).toBe(409);
    expect(acc.body.reason).toBe("ORG_ALREADY_QUOTED");
    expect((await assignment(a.body.data.id)).status).toBe("PENDING");

    const again = await assign(rfq.rfq_id, C);
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("ORG_ALREADY_QUOTED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: HQ, is_regret: 0 }]);
  });

  it("3b. a suspended member that quoted keeps its quote; the principal then gets 409 ORG_ALREADY_QUOTED", async () => {
    const rfq = await openRfq();
    const id = await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq)).status).toBe(200);

    // Suspension revokes the entity's live assignments; an ENTITY_* release is never refused.
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [B]);
    expect(await revokeLiveAssignmentsForEntity(B, { reason: "ENTITY_SUSPENDED", orgId: ORG_A })).toBe(1);
    expect((await assignment(id)).status).toBe("REVOKED");
    expect(await rowsOf(rfq.rfq_id, B)).toHaveLength(1); // it quoted: the buyer still sees it

    const hq = await createQuote(HQ, rfq);
    expect(hq.status).toBe(409);
    expect(hq.body.reason).toBe("ORG_ALREADY_QUOTED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: B, is_regret: 0 }]);
  });

  it("3c. updateQuoteItems: a member whose assignment ended can no longer change its quote (403 ROUTING_REQUIRED)", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq)).status).toBe(200);
    const quoteId = (await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id = $1`, [rfq.rfq_id])).id;

    const ok = await (await httpClient(B)).put(`/api/v1/rfq/quote/update/${quoteId}`).send(quoteBody(rfq, { price: 90 }));
    expect(ok.status).toBe(200);

    await revokeLiveAssignmentsForEntity(B, { reason: "ENTITY_SUSPENDED", orgId: ORG_A }); // entity stays ACTIVE here
    const res = await (await httpClient(B)).put(`/api/v1/rfq/quote/update/${quoteId}`).send(quoteBody(rfq, { price: 80 }));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("ROUTING_REQUIRED");
    const { unit_price } = await db.one(`SELECT unit_price FROM tbl_quote_items WHERE quote_id = $1`, [quoteId]);
    expect(Number(unit_price)).toBe(90);
  });

  it("3d. the emailed-link (token) path is gated too: principal → 409 ROUTED_TO_MEMBER", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const token = 9595100000 + Math.floor(Math.random() * 99999);
    await db.none(
      `INSERT INTO tbl_vendor_rfq_tokens_non_login (id, token, vendor_id, rfq_no)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM tbl_vendor_rfq_tokens_non_login), $1, $2, $3)`,
      [token, HQ, rfq.rfq_no]
    );
    const anon = await httpClient(null);
    const res = await anon.post(`/api/v1/rfq/quote/create?token=${token}`).send(quoteBody(rfq));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("ROUTED_TO_MEMBER");
  });
});

describe("releases", () => {
  it("4. decline → the member's routed rows are gone and its RFQ GET answers like any unmapped vendor's", async () => {
    const rfq = await openRfq();
    const a = await assign(rfq.rfq_id, B);
    const res = await respond(B, a.body.data.id, { decision: "DECLINE", reason: "NO_STOCK" });
    expect(res.status).toBe(200);

    expect(await rowsOf(rfq.rfq_id, B)).toEqual([]);
    expect(await rowsOf(rfq.rfq_id, HQ)).toHaveLength(1); // the principal's invite is untouched
    const unmapped = await vendorGet(C, rfq.rfq_id);
    const member = await vendorGet(B, rfq.rfq_id);
    expect(member.status).toBe(unmapped.status);
    expect(member.body).toEqual(unmapped.body);
    expect(member.body.data).toEqual([]);
  });

  it("5. the principal can quote after the member timed out (sweep, past due_at)", async () => {
    const rfq = await openRfq();
    const a = await assign(rfq.rfq_id, B);
    const id = a.body.data.id;
    await db.none(`UPDATE tbl_vendor_routing_assignments SET due_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    const tick = await runVendorRoutingSweepTick(new Date());
    expect(tick.timedOut).toBeGreaterThanOrEqual(1);
    expect((await assignment(id)).status).toBe("TIMED_OUT");
    expect(await rowsOf(rfq.rfq_id, B)).toEqual([]);

    const res = await createQuote(HQ, rfq);
    expect(res.status).toBe(200);
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: HQ, is_regret: 0 }]);
  });

  it("6. revoke after the member quoted → 409 QUOTE_SUBMITTED, the assignment stays ACCEPTED", async () => {
    const rfq = await openRfq();
    const id = await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq)).status).toBe(200);

    const res = await revoke(id);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("QUOTE_SUBMITTED");
    expect((await assignment(id)).status).toBe("ACCEPTED");
    expect(await rowsOf(rfq.rfq_id, B)).toHaveLength(1);
  });

  it("6b. a member that regretted may be revoked; it keeps its rows (it answered) and the principal may then quote", async () => {
    const rfq = await openRfq();
    const id = await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq, { regret: true })).status).toBe(200);

    expect((await revoke(id)).status).toBe(200);
    expect((await assignment(id)).status).toBe("REVOKED");
    expect(await rowsOf(rfq.rfq_id, B)).toHaveLength(1);

    expect((await createQuote(HQ, rfq)).status).toBe(200);
    expect(await quotesOf(rfq.rfq_id)).toEqual([
      { created_by: B, is_regret: 1 },
      { created_by: HQ, is_regret: 0 },
    ]);
  });
});

describe("buyer view", () => {
  it("7. invited-vendor counts ignore routed rows; vendor and quote lists carry org_name", async () => {
    const rfq = await openRfq();
    const buyer = await httpClient(BUYER);
    const detail = async () => {
      const res = await buyer.get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}?includeVendors=true`);
      expect(res.status).toBe(200);
      return res.body.data.products[0];
    };
    // POST /rfq/list-view's per-card details (the controller reads vendors[0].total_vendors)
    const cardCount = async () => {
      const { vendors } = (await rfqModel.getRfqListViewCardDetails([rfq.rfq_id], BUYER))[rfq.rfq_id];
      return (typeof vendors === "string" ? JSON.parse(vendors) : vendors)[0].total_vendors;
    };

    // GET /rfq/lifecycle-summary/:id → the awaiting-quotes rollup; GET /rfq/quote-comparison-view/:id
    const awaiting = async () => {
      const res = await buyer.get(`/api/v1/rfq/lifecycle-summary/${rfq.rfq_id}`);
      expect(res.status).toBe(200);
      const found = findKey(res.body.data, "awaiting_quotes");
      expect(found).toBeTruthy();
      return found;
    };
    const quotesInvited = async () => {
      const res = await buyer.get(`/api/v1/rfq/quote-comparison-view/${rfq.rfq_id}`);
      expect(res.status).toBe(200);
      return findKey(res.body, "quotes_invited");
    };

    expect((await detail()).vendors_count).toBe("3");
    expect(Number(await cardCount())).toBe(3);
    expect(await awaiting()).toMatchObject({ total_invited: 3, participated: 0, remaining: 3 });
    expect(await quotesInvited()).toBe(3);

    await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq)).status).toBe(200);

    const product = await detail();
    expect(product.vendors_count).toBe("3"); // HQ counted once, B's routed copy excluded
    expect(Number(await cardCount())).toBe(3);
    // the org is invited once and, its member having quoted, is not remaining
    expect(await awaiting()).toMatchObject({ total_invited: 3, participated: 1, sent_quotes: 1, remaining: 2 });
    expect(await quotesInvited()).toBe(3);
    const orgOf = Object.fromEntries(product.vendor_details.map((v) => [v.user_id, v.org_name]));
    // Task 22: the invite list is the org's principal (labelled with its org), not B's copy;
    // the member who quoted is named in the quote lists below.
    expect(orgOf).toEqual({ [HQ]: "Org A Network", [FHQ]: "Org F Network", [NO]: null });

    // quotes are visible to the buyer once bidding has closed
    await db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [rfq.rfq_id, istString(-HOUR)]);
    const quotes = await buyer.get(`/api/v1/rfq/get-quotes/${rfq.rfq_id}`);
    expect(quotes.status).toBe(200);
    const vd = quotes.body.data
      .flatMap((p) => p.quotations || [])
      .map((q) => (q.quote_details || q).vendor_details)
      .filter(Boolean);
    expect(vd.map((v) => [v.id, v.org_name])).toEqual([[B, "Org A Network"]]);

    const view = await buyer.get(`/api/v1/rfq/quote-comparison-view/${rfq.rfq_id}`);
    expect(view.status).toBe(200);
    expect(view.body.vendors.map((v) => [v.id, v.org_name])).toEqual([[B, "Org A Network"]]);
  });

  it("7c. the buyer dashboard's no-response drill-down counts invited vendors without routed rows", async () => {
    const rfq = await openRfq();
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [
      rfq.rfq_id,
      IDS.hotels.A1,
      BUYER,
    ]);
    expect((await assign(rfq.rfq_id, B)).status).toBe(201); // B holds a routed copy now
    const res = await (await httpClient(BUYER)).get("/api/v1/dashboard-v2/no-response").query({ hotel_ids: String(IDS.hotels.A1) });
    expect(res.status).toBe(200);
    const row = res.body.data.active.find((r) => r.id === rfq.rfq_id);
    expect(row).toBeTruthy();
    expect(row.invited_vendor_count).toBe(3); // HQ, FHQ, NO; not B's routed copy
  });

  it("8. the buyer finalizes the member's quote → the award (tbl_quote_finalization) names the member", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    expect((await createQuote(B, rfq)).status).toBe(200);
    const item = await db.one(`SELECT id FROM tbl_quote_items WHERE rfq_id = $1`, [rfq.rfq_id]);
    // finalize needs the buyer in the company's PO hierarchy (or no hierarchy at all)
    const { company_id } = await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [BUYER]);
    hierarchyIds.push(
      (
        await db.one(
          `INSERT INTO tbl_approval_hierarchy (company_id, user_id, approval_level, bypass_cap, hierarchy_type)
           VALUES ($1, $2, 1, 0, 'po') RETURNING id`,
          [company_id, BUYER]
        )
      ).id
    );
    // bids closed: finalization opens
    await db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [rfq.rfq_id, istString(-HOUR)]);

    const res = await (await httpClient(BUYER)).post("/api/v1/rfq/finalize").send({
      rfq_id: rfq.rfq_id,
      rfq_no: rfq.rfq_no,
      product_variant_id: VARIANT,
      variant: 0,
      vendor_id: B,
      quote_id: item.id,
      quote_item_id: item.id,
      route_type: "PO",
      comment: "awarding the routed member",
    });
    expect(res.status).toBe(200);
    const fin = await db.any(`SELECT vendor_id FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfq_id]);
    expect(fin.map((f) => f.vendor_id)).toEqual([B]);
  });
});

describe("a linked entity's own direct invite (invited before it joined the org)", () => {
  // C holds a plain invite row (routed_from_vendor_id NULL) next to the principal's.
  it("12a. the entity quotes and updates on its direct invite; the principal then gets 409 ORG_ALREADY_QUOTED", async () => {
    const rfq = await openRfq({ invite: [HQ, C, FHQ] });

    const res = await createQuote(C, rfq);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: C, is_regret: 0 }]);

    const quoteId = (await db.one(`SELECT id FROM tbl_quotes WHERE rfq_id = $1`, [rfq.rfq_id])).id;
    const upd = await (await httpClient(C)).put(`/api/v1/rfq/quote/update/${quoteId}`).send(quoteBody(rfq, { price: 90 }));
    expect(upd.status).toBe(200);
    const { unit_price } = await db.one(`SELECT unit_price FROM tbl_quote_items WHERE quote_id = $1`, [quoteId]);
    expect(Number(unit_price)).toBe(90);

    const hq = await createQuote(HQ, rfq);
    expect(hq.status).toBe(409);
    expect(hq.body.reason).toBe("ORG_ALREADY_QUOTED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: C, is_regret: 0 }]);
  });

  it("12b. a regret on the direct invite is allowed (it writes a quote row)", async () => {
    const rfq = await openRfq({ invite: [HQ, C, FHQ] });
    const res = await createQuote(C, rfq, { regret: true });
    expect(res.status).toBe(200);
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: C, is_regret: 1 }]);
  });

  it("12c. one quote per org still holds: the principal quoted first → the entity gets 409 ORG_ALREADY_QUOTED", async () => {
    const rfq = await openRfq({ invite: [HQ, C, FHQ] });
    expect((await createQuote(HQ, rfq)).status).toBe(200);
    const res = await createQuote(C, rfq);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("ORG_ALREADY_QUOTED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: HQ, is_regret: 0 }]);
  });

  it("12d. while the RFQ is routed to another member (ACCEPTED), the directly-invited entity gets 409 ROUTED_TO_MEMBER", async () => {
    const rfq = await openRfq({ invite: [HQ, C, FHQ] });
    await routeAndAccept(rfq.rfq_id, B);
    const res = await createQuote(C, rfq);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("ROUTED_TO_MEMBER");
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });

  it("12e. a member holding only a routed copy (no direct invite, no assignment) is still refused (403 ROUTING_REQUIRED)", async () => {
    const rfq = await openRfq();
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant, routed_from_vendor_id)
       VALUES ($1, $2, $3, 0, $4)`,
      [rfq.rfq_id, VARIANT, B, HQ]
    );
    const res = await createQuote(B, rfq);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("ROUTING_REQUIRED");
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });

  it("12g. a SUSPENDED entity with a direct invite is refused by the quote gate itself (403 NOT_ACTIVE), not only by the route's operate check", async () => {
    const rfq = await openRfq({ invite: [HQ, C, FHQ] });
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [C]);
    await expect(db.tx((t) => assertOrgMayQuote(rfq.rfq_id, C, t))).rejects.toMatchObject({ http: 403, reason: "NOT_ACTIVE" });
    const res = await createQuote(C, rfq);
    expect(res.status).toBe(403);
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });

  it("12f. the routing queue does not list an RFQ an ACTIVE member holds a direct invite to", async () => {
    const direct = await openRfq({ invite: [HQ, C, FHQ] });
    const free = await openRfq();
    const items = await rfqSubjectHandler.listUnrouted(ORG_A, db);
    const mine = items.filter((i) => rfqIds.includes(i.subjectId)).map((i) => i.subjectId);
    expect(mine).toEqual([free.rfq_id]);
    expect(mine).not.toContain(direct.rfq_id);
    // a SUSPENDED member cannot quote: the RFQ needs routing again
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [C]);
    const after = (await rfqSubjectHandler.listUnrouted(ORG_A, db)).map((i) => i.subjectId);
    expect(after).toEqual(expect.arrayContaining([direct.rfq_id, free.rfq_id]));
  });
});

describe("isolation and back-compat", () => {
  it("9. sibling isolation: C cannot read or quote the RFQ routed to B", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const get = await vendorGet(C, rfq.rfq_id);
    expect(get.status).toBe(200);
    expect(get.body.data).toEqual([]);
    const res = await createQuote(C, rfq);
    // the RFQ access check (no invite rows for C) refuses before the network gate
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 3, message: "The RFQ is not belongs to you!" });
    expect(await quotesOf(rfq.rfq_id)).toEqual([]);
  });

  it("10. two orgs route one RFQ: each member's rows come from its own principal, both quote", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id, B, HQ);
    await routeAndAccept(rfq.rfq_id, FB, FHQ);
    expect((await rowsOf(rfq.rfq_id, B)).map((r) => r.routed_from_vendor_id)).toEqual([HQ]);
    expect((await rowsOf(rfq.rfq_id, FB)).map((r) => r.routed_from_vendor_id)).toEqual([FHQ]);

    expect((await createQuote(B, rfq)).status).toBe(200);
    expect((await createQuote(FB, rfq)).status).toBe(200);
    expect((await createQuote(FHQ, rfq)).body.reason).toBe("ROUTED_TO_MEMBER");
    expect((await quotesOf(rfq.rfq_id)).map((q) => q.created_by).sort()).toEqual([B, FB]);
  });

  it("11. a vendor in no network quotes as before, and the gate costs it no query", async () => {
    const rfq = await openRfq();
    const client = await httpClient(NO);
    const { result: res, statements } = await countQueries(() =>
      client.post("/api/v1/rfq/quote/create").send(quoteBody(rfq))
    );
    expect(res.status).toBe(200);
    expect(await quotesOf(rfq.rfq_id)).toEqual([{ created_by: NO, is_regret: 0 }]);
    const texts = statements.map((s) => (typeof s === "string" ? s : s.text ?? ""));
    expect(texts.filter((s) => /pg_advisory_xact_lock|tbl_vendor_routing_assignments/.test(s))).toEqual([]);
    // the placement lookup the gate would run is jwtUsr's alone (once per request)
    expect(texts.filter((s) => /AS entity_status, o\.name AS org_name/.test(s))).toHaveLength(1);

    // the buyer's quote lists carry org_name: null for it, in both
    await db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [rfq.rfq_id, istString(-HOUR)]);
    const buyer = await httpClient(BUYER);
    const quotes = await buyer.get(`/api/v1/rfq/get-quotes/${rfq.rfq_id}`);
    const vd = quotes.body.data.flatMap((p) => p.quotations || []).map((q) => q.quote_details.vendor_details);
    expect(vd.map((v) => [v.id, v.org_name])).toEqual([[NO, null]]);
    const view = await buyer.get(`/api/v1/rfq/quote-comparison-view/${rfq.rfq_id}`);
    expect(view.body.vendors.map((v) => [v.id, v.org_name])).toEqual([[NO, null]]);
  });
});

describe("routed copies follow the principal's invite (RFQ edits)", () => {
  /** The Edit RFQ snapshot in the wire shape the FE sends (ids, not the model's objects). */
  async function editSnapshot(rfqId) {
    const snap = JSON.parse(JSON.stringify(await rfqModel.getFullRfqForEdit(rfqId)));
    const idOf = (v) => (v && typeof v === "object" ? Number(v.user_id ?? v.terms_id ?? v.term_id ?? v.id) : v);
    snap.terms = (snap.terms || []).map(idOf);
    for (const p of snap.products) p.vendors = (p.vendors || []).map(idOf);
    return snap;
  }
  const newLine = (productVariantId, vendors) => ({
    id: null,
    product_variant_id: productVariantId,
    variant: 0,
    product_name: "added after routing",
    comment: "",
    specs: { Quantity: "5", Unit: "NOS" },
    files: { qap_file: [], spec_file: [], datasheet_file: [] },
    vendors,
    tech_eval_clauses: [],
  });
  /** PUT /rfq/update as the creator: adds VARIANT2 invited to `vendors`. */
  async function addProduct(rfqId, vendors) {
    const snap = await editSnapshot(rfqId);
    snap.products.push(newLine(VARIANT2, vendors));
    return (await httpClient(BUYER)).put("/api/v1/rfq/update").send({ rfq_id: rfqId, snapshot: snap });
  }
  const variantsOf = async (rfqId, userId) =>
    (await rowsOf(rfqId, userId)).map((r) => [r.product_variant_id, r.routed_from_vendor_id]);

  it("(a) route + accept, then the buyer adds a product → the member gets its row and quotes it", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const res = await addProduct(rfq.rfq_id, [HQ, NO]);
    expect(res.status).toBe(200);

    expect(await variantsOf(rfq.rfq_id, B)).toEqual([
      [VARIANT, HQ],
      [VARIANT2, HQ],
    ]);
    const q = await createQuote(B, rfq, { variants: [VARIANT, VARIANT2] });
    expect(q.status).toBe(200);
    const items = await db.any(`SELECT product_variant_id FROM tbl_quote_items WHERE rfq_id = $1 ORDER BY product_variant_id`, [rfq.rfq_id]);
    expect(items.map((i) => i.product_variant_id)).toEqual([VARIANT, VARIANT2].sort((x, y) => x - y));
  });

  it("(b) after DECLINED, adding a product creates no row for the member", async () => {
    const rfq = await openRfq();
    const a = await assign(rfq.rfq_id, B);
    expect((await respond(B, a.body.data.id, { decision: "DECLINE", reason: "NO_STOCK" })).status).toBe(200);
    expect((await addProduct(rfq.rfq_id, [HQ])).status).toBe(200);
    expect(await rowsOf(rfq.rfq_id, B)).toEqual([]);
    expect(await variantsOf(rfq.rfq_id, HQ)).toEqual([
      [VARIANT, null],
      [VARIANT2, null],
    ]);
  });

  it("(c) two orgs on one RFQ: each member only gets rows of its own principal", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id, B, HQ);
    const f = await assign(rfq.rfq_id, FB, FHQ); // PENDING is live too
    expect(f.status).toBe(201);
    // the new product is invited to HQ only: FB (org F) must not get it
    expect((await addProduct(rfq.rfq_id, [HQ])).status).toBe(200);

    expect(await variantsOf(rfq.rfq_id, B)).toEqual([
      [VARIANT, HQ],
      [VARIANT2, HQ],
    ]);
    expect(await variantsOf(rfq.rfq_id, FB)).toEqual([[VARIANT, FHQ]]);
    // idempotent: a second pass adds nothing
    expect(await propagateRoutedCopies(db, rfq.rfq_id)).toBe(0);
  });

  it("Task 22: the buyer's vendor_details lists the principal, never the routed member (org shown via org_name)", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    expect(await rowsOf(rfq.rfq_id, B)).toHaveLength(1);
    const res = await (await httpClient(BUYER)).get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}?includeVendors=true`);
    expect(res.status).toBe(200);
    const vd = res.body.data.products[0].vendor_details;
    expect(vd.map((v) => v.user_id).sort((x, y) => x - y)).toEqual([HQ, FHQ, NO].sort((x, y) => x - y));
    expect(vd.find((v) => v.user_id === HQ).org_name).toBe("Org A Network");
  });

  it("Task 22: an edit that re-sends the routed member as a vendor keeps its rows routed and creates no direct invite", async () => {
    const rfq = await openRfq();
    const id = await routeAndAccept(rfq.rfq_id);
    // A stale or hand-made snapshot: B listed on the existing line and on a new line.
    const snap = await editSnapshot(rfq.rfq_id);
    snap.products[0].vendors = [...new Set([...snap.products[0].vendors, B])];
    snap.products.push(newLine(VARIANT2, [HQ, B]));
    const res = await (await httpClient(BUYER)).put("/api/v1/rfq/update").send({ rfq_id: rfq.rfq_id, snapshot: snap });
    expect(res.status).toBe(200);

    // B: one routed copy per line (the new line's comes from HQ's row), none direct.
    expect(await variantsOf(rfq.rfq_id, B)).toEqual(
      [[VARIANT, HQ], [VARIANT2, HQ]].sort((x, y) => x[0] - y[0])
    );
    // HQ is invited once per line.
    expect((await rowsOf(rfq.rfq_id, HQ)).map((r) => r.product_variant_id).sort((x, y) => x - y)).toEqual(
      [VARIANT, VARIANT2].sort((x, y) => x - y)
    );
    // B still quotes only through the assignment: once it ends, B holds nothing.
    expect((await revoke(id)).status).toBe(200);
    expect(await rowsOf(rfq.rfq_id, B)).toEqual([]);
  });

  it("Task 22: POST /rfq/save-draft never deletes a routed copy nor adds the routed member as a direct invite", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const rp = await db.one(`SELECT id FROM tbl_rfq_products WHERE rfq_id = $1 AND product_variant_id = $2`, [rfq.rfq_id, VARIANT]);
    const res = await (await httpClient(BUYER))
      .post("/api/v1/rfq/save-draft")
      .send({
        rfq_id: rfq.rfq_id,
        filters: { global: {}, local: {} },
        updatableData: { vendors: { [rp.id]: { product_id: VARIANT, variant: 0, deletable: [B], addable: [B] } } },
      });
    expect(res.status).toBe(200);
    expect(await rowsOf(rfq.rfq_id, B)).toEqual([
      { user_id: B, routed_from_vendor_id: HQ, product_variant_id: VARIANT, variant: 0 },
    ]);
  });

  it("an edit removing + adding products racing a release (engine holds the assignment FOR UPDATE) neither deadlocks nor errors", async () => {
    const rfq = await openRfq();
    // a second line invited to HQ, copied to B by the routing
    const second = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.rfq_id, VARIANT2]
    );
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', '3', 0), ($1, $2, 'Unit', 'NOS', 0)`,
      [rfq.rfq_id, VARIANT2]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
      [rfq.rfq_id, VARIANT2, HQ]
    );
    const id = (await assign(rfq.rfq_id, B)).body.data.id;
    expect(await rowsOf(rfq.rfq_id, B)).toHaveLength(2);

    // The edit: drop the VARIANT2 line (its rows, B's copy included) and add a VARIANT_CAT line.
    const snap = await editSnapshot(rfq.rfq_id);
    snap.products = snap.products.filter((p) => Number(p.id) !== Number(second.id));
    snap.deleted_product_ids = [second.id];
    snap.products.push(newLine(VARIANT_CAT, [HQ]));

    let edit;
    // The engine side of a decline, step by step with its own locks: subject lock, then the
    // assignment FOR UPDATE, then (after the edit is parked) the status change and the
    // RFQ handler's onReleased, which deletes B's routed rows.
    await db.tx(async (t1) => {
      await lockRoutingSubject(t1, { orgId: ORG_A, subjectType: "RFQ", subjectId: rfq.rfq_id, hotelId: null });
      await getAssignment(id, t1, { forUpdate: true });

      const client = await httpClient(BUYER);
      edit = client.put("/api/v1/rfq/update").send({ rfq_id: rfq.rfq_id, snapshot: snap }).then((r) => r);

      // Wait until the edit is blocked on the assignment lock.
      for (let i = 0; ; i++) {
        const waiting = await db.oneOrNone(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%tbl_vendor_routing_assignments%' AND query ILIKE '%FOR SHARE%'
            LIMIT 1`
        );
        if (waiting) break;
        if (i > 200) throw new Error("the edit never waited on the routing assignment lock");
        await new Promise((r) => setTimeout(r, 25));
      }

      const updated = await releaseAssignment(t1, id, { status: "DECLINED", actorUserId: B, declineReason: "NO_STOCK" });
      await rfqSubjectHandler.onReleased({ ...updated, release_reason: "DECLINED" }, "PENDING", t1);
    });

    const res = await edit;
    expect(res.status).toBe(200);
    expect((await assignment(id)).status).toBe("DECLINED");
    expect(await rowsOf(rfq.rfq_id, B)).toEqual([]); // released: no copies, not even of the new line
    expect((await rowsOf(rfq.rfq_id, HQ)).map((r) => r.product_variant_id).sort((x, y) => x - y)).toEqual(
      [VARIANT, VARIANT_CAT].sort((x, y) => x - y)
    );
  });

  it("a write path's propagate racing the engine's onAccepted catch-up adds no duplicate member row", async () => {
    // The race (single-statement propagate): HQ's new row is committed; the engine's catch-up
    // copies it to B while holding B's assignment FOR UPDATE; a concurrent propagate waits on
    // that lock and, re-checking only the locked row, would insert B's copy a second time.
    const rfq = await openRfq();
    const id = await routeAndAccept(rfq.rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
      [rfq.rfq_id, VARIANT2, HQ]
    );

    let racer;
    await db.tx(async (t1) => {
      await lockRoutingSubject(t1, { orgId: ORG_A, subjectType: "RFQ", subjectId: rfq.rfq_id, hotelId: null });
      await getAssignment(id, t1, { forUpdate: true });
      expect(await propagateRoutedCopies(t1, rfq.rfq_id, { assignmentId: id })).toBe(1);

      racer = propagateRoutedCopiesLocked(db, rfq.rfq_id);
      for (let i = 0; ; i++) {
        const waiting = await db.oneOrNone(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%tbl_vendor_routing_assignments%'
            LIMIT 1`
        );
        if (waiting) break;
        if (i > 200) throw new Error("the propagate never waited on the routing assignment lock");
        await new Promise((r) => setTimeout(r, 25));
      }
    });

    expect(await racer).toBe(0);
    expect((await rowsOf(rfq.rfq_id, B)).map((r) => r.product_variant_id).sort((x, y) => x - y)).toEqual(
      [VARIANT, VARIANT2].sort((x, y) => x - y)
    );
  });

  /** HQ becomes eligible for VARIANT_CAT at hotel A1 (variant mapping + hotel and category subs). */
  async function makeHqEligible() {
    await db.none(
      `INSERT INTO tbl_product_variant_vendor_mapping
         (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
       VALUES ($1, $2, true, true, $2, now(), now())`,
      [VARIANT_CAT, HQ]
    );
    await grantVendorHotelSubs([HQ], [IDS.hotels.A1]);
    await grantVendorCategorySub(HQ, CAT);
  }
  /** An RFQ as in openRfq plus a VARIANT_CAT line invited to NO only, and its hotel mapping. */
  async function rfqWithUninvitedLine() {
    const rfq = await openRfq();
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq.rfq_id, VARIANT_CAT]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
      [rfq.rfq_id, VARIANT_CAT, NO]
    );
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [
      rfq.rfq_id,
      IDS.hotels.A1,
      BUYER,
    ]);
    return rfq;
  }

  it("POST /hospitality/vendor/join-open-rfqs (HQ joins a new line) → the member gets its copy", async () => {
    const rfq = await rfqWithUninvitedLine();
    await routeAndAccept(rfq.rfq_id);
    await makeHqEligible();
    const res = await (await httpClient(HQ))
      .post("/api/v1/hospitality/vendor/join-open-rfqs")
      .send({ rfq_ids: [rfq.rfq_id] });
    expect(res.status).toBe(200);
    expect(res.body.data.joined_count).toBe(1);
    expect(await variantsOf(rfq.rfq_id, B)).toEqual(
      [[VARIANT, HQ], [VARIANT_CAT, HQ]].sort((x, y) => x[0] - y[0])
    );
  });

  it("POST /rfq/refresh-vendors (HQ newly eligible on a line) → the member gets its copy", async () => {
    const rfq = await rfqWithUninvitedLine();
    await routeAndAccept(rfq.rfq_id);
    await makeHqEligible();
    const res = await (await httpClient(BUYER)).post("/api/v1/rfq/refresh-vendors").send({ rfq_id: rfq.rfq_id });
    expect(res.status).toBe(200);
    expect((await rowsOf(rfq.rfq_id, HQ)).map((r) => r.product_variant_id)).toContain(VARIANT_CAT);
    expect(await variantsOf(rfq.rfq_id, B)).toEqual(
      [[VARIANT, HQ], [VARIANT_CAT, HQ]].sort((x, y) => x[0] - y[0])
    );
  });

  it("POST /rfq/add-product-to-rfq (deprecated route, explicit vendors) → the member gets its copy", async () => {
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    const res = await (await httpClient(BUYER))
      .post("/api/v1/rfq/add-product-to-rfq")
      .send({ rfq_id: rfq.rfq_id, variant_id: VARIANT2, vendors: [HQ], specs: {} });
    expect(res.status).toBe(200);
    expect((await variantsOf(rfq.rfq_id, B)).map(([v]) => v).sort((x, y) => x - y)).toEqual(
      [VARIANT, VARIANT2].sort((x, y) => x - y)
    );
  });

  it("tech-eval replacement vendor row (rfqModel.addTechEvalReplacementVendorRow, used by handleTechnicalPostApproval) → the member gets its copy", async () => {
    // The full scored tech-eval approval cannot be driven deterministically here (it needs a
    // failed round, a reserve or quoting vendor without an invite row, and the approval
    // engine); the row writer it calls is exercised against the real tables instead.
    const rfq = await openRfq();
    await routeAndAccept(rfq.rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq.rfq_id, VARIANT2]
    );
    await db.tx((t) =>
      rfqModel.addTechEvalReplacementVendorRow(t, { rfqId: rfq.rfq_id, productVariantId: VARIANT2, variant: 0, vendorId: HQ })
    );
    expect(await variantsOf(rfq.rfq_id, B)).toEqual(
      [[VARIANT, HQ], [VARIANT2, HQ]].sort((x, y) => x[0] - y[0])
    );
  });
});

describe("handler", () => {
  it("is the registered RFQ subject", () => {
    expect(getSubjectHandler("RFQ")).toBe(rfqSubjectHandler);
  });

  it("dueCap = bid_end − 6h as an IST instant, whatever the PG session timezone (UTC, Singapore, Kolkata)", async () => {
    const rfq = await openRfq({ bidEndOffsetMs: 30 * HOUR });
    const { bid_end_date } = await db.one(`SELECT bid_end_date FROM tbl_rfq WHERE id = $1`, [rfq.rfq_id]);
    // bid_end_date is IST wall clock: the instant is that wall clock minus 5h30m.
    const bidEndInstant = new Date(`${bid_end_date.replace(" ", "T")}Z`).getTime() - 5.5 * HOUR;
    for (const zone of ["UTC", "Asia/Singapore", "Asia/Kolkata"]) {
      const v = await db.tx(async (t) => {
        await t.none(`SET LOCAL TIME ZONE '${zone}'`);
        return rfqSubjectHandler.validateSubject({ orgId: ORG_A, principalVendorId: HQ, subjectId: rfq.rfq_id, hotelId: null }, t);
      });
      expect(v.ok).toBe(true);
      expect(v.dueCap).toBeInstanceOf(Date);
      expect(v.dueCap.getTime()).toBe(bidEndInstant - 6 * HOUR);
      expect(v.hotelIds).toEqual([IDS.hotels.A1]);
    }
  });

  it("the bid-end check is IST: an RFQ that closed 1h ago (IST) is not routable under a UTC session", async () => {
    const rfq = await openRfq({ bidEndOffsetMs: -HOUR });
    const v = await db.tx(async (t) => {
      await t.none(`SET LOCAL TIME ZONE 'UTC'`);
      return rfqSubjectHandler.validateSubject({ orgId: ORG_A, principalVendorId: HQ, subjectId: rfq.rfq_id, hotelId: null }, t);
    });
    expect(v).toMatchObject({ ok: false, http: 409, code: "RFQ_NOT_OPEN" });
  });

  it("assign caps due_at at bid_end − 6h (bid ends in 8h, org timeout 24h → due in ~2h)", async () => {
    const rfq = await openRfq({ bidEndOffsetMs: 8 * HOUR });
    const a = await assign(rfq.rfq_id, B);
    expect(a.status).toBe(201);
    const due = new Date((await assignment(a.body.data.id)).due_at).getTime();
    expect(Math.abs(due - (Date.now() + 2 * HOUR))).toBeLessThan(2 * 60 * 1000);
  });

  it("refuses: an RFQ the principal is not invited to (404), a closed RFQ (409), a hotel id (400)", async () => {
    const notInvited = await openRfq({ invite: [NO] });
    expect((await assign(notInvited.rfq_id, B)).status).toBe(404);
    const closed = await openRfq();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [closed.rfq_id]);
    expect((await assign(closed.rfq_id, B)).body.reason).toBe("RFQ_NOT_OPEN");
    const withHotel = await (await httpClient(HQ))
      .post(`${BASE}/routing/assign`)
      .send({ subject_type: "RFQ", subject_id: closed.rfq_id, hotel_id: IDS.hotels.A1, assignee_vendor_id: B });
    expect(withHotel.status).toBe(400);
    expect(await db.any(`SELECT 1 FROM tbl_vendor_routing_assignments WHERE org_id = $1`, [ORG_A])).toEqual([]);
  });

  it("listUnrouted: open RFQs invited to the principal, minus routed, quoted and closed ones", async () => {
    const free = await openRfq();
    const routed = await openRfq();
    const quoted = await openRfq();
    const closed = await openRfq();
    const other = await openRfq({ invite: [FHQ] });
    await assign(routed.rfq_id, B);
    expect((await createQuote(HQ, quoted)).status).toBe(200);
    await db.none(`UPDATE tbl_rfq SET bid_end_date = $2 WHERE id = $1`, [closed.rfq_id, istString(-HOUR)]);

    const items = await rfqSubjectHandler.listUnrouted(ORG_A, db);
    const mine = items.filter((i) => rfqIds.includes(i.subjectId));
    expect(mine.map((i) => i.subjectId)).toEqual([free.rfq_id]);
    expect(mine[0]).toMatchObject({ hotelId: null, hotelIds: [IDS.hotels.A1] });
    expect(mine[0].title).toContain(`RFQ #${free.rfq_no}`);
    expect((await rfqSubjectHandler.listUnrouted(ORG_F, db)).map((i) => i.subjectId)).toEqual(
      expect.arrayContaining([other.rfq_id, free.rfq_id])
    );
  });

  it("describe: RFQ number and title, linking to the vendor RFQ page", async () => {
    const rfq = await openRfq();
    const d = await rfqSubjectHandler.describe({ subject_id: rfq.rfq_id }, db);
    expect(d).toEqual({
      title: `RFQ #${rfq.rfq_no} · VN routed RFQ`,
      actionUrl: `/dashboard/vendor/inquiries-details?id=${rfq.rfq_id}`,
    });
  });
});
