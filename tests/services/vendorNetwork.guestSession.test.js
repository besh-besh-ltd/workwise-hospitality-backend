// Guest sessions (security audit H1, Task 23 S1). The emailed RFQ link is exchanged by
// POST /users/verify-vendor-token for a 30-minute JWT carrying `guest: true`. Whoever
// holds the link holds that session, so it may view, quote and regret on the RFQ and
// nothing else: every network/account route answers 403 { reason: 'GUEST_SESSION' }.
// Pattern B: committed fixtures (ids 95561..95569), removed in afterEach. Every call
// is real HTTP with the real token minted by the real endpoint.

import bcrypt from "bcryptjs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { buildTestApp } from "../setup/app.js";
import { boundRequest, httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import {
  seedVendorEntity,
  seedOrg,
  addEntity,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";

const HQ = 95561; // principal of ORG (ORG_ADMIN acting as itself)
const BRANCH = 95562; // ACTIVE BRANCH of ORG
const LONE = 95563; // vendor in no network
const ORG = 95561;
const BUYER = IDS.users.a1_proc_buyer;
const UA = "jest-test-agent";
const BASE = "/api/v1/vendor-network";
const HOUR = 3600 * 1000;
const PASSWORD_HASH = bcrypt.hashSync("Secret@123", 4);

const rfqIds = [];
let VARIANT;

beforeAll(async () => {
  VARIANT = (await db.one(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`)).id;
});

beforeEach(async () => {
  for (const id of [HQ, BRANCH, LONE]) {
    await seedVendorEntity({ id, companyId: id, name: `VN Guest ${id}`, email: `vn-guest-${id}@example.com`, password: PASSWORD_HASH });
  }
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "Guest Test Network" });
  await addEntity({ orgId: ORG, vendorId: BRANCH });
});

afterEach(async () => {
  await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id BETWEEN 95561 AND 95569`);
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_change_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    rfqIds.length = 0;
  }
  await cleanupVendorNetworkFixtures();
});

afterAll(closeDb);

const istString = (offsetMs) =>
  new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
const utcString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

/** A published, open RFQ (one product) inviting `vendorId`. */
async function openRfqFor(vendorId) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: utcString(-2 * 24 * HOUR),
    vendor_clarification_date: utcString(-24 * HOUR),
    bid_end_date: istString(3 * 24 * HOUR),
    department: IDS.departments.proc,
    title: "VN guest RFQ",
  });
  rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)`,
    [rfq_id, VARIANT]
  );
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
     VALUES ($1, $2, 'Quantity', '10', 0), ($1, $2, 'Unit', 'NOS', 0)`,
    [rfq_id, VARIANT]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT, vendorId]
  );
  return { rfq_id, rfq_no };
}

/** The emailed link's token for `vendorId`, exchanged for the guest JWT exactly as the FE does. */
async function guestTokenFor(vendorId, rfqNo = 1) {
  const linkToken = "4" + String(vendorId).padStart(17, "0"); // 18 digits, unique per vendor
  await db.none(
    `INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no) VALUES ($1, $2, $3)`,
    [linkToken, vendorId, rfqNo]
  );
  const app = await buildTestApp();
  const res = await (await boundRequest(app))
    .post("/api/v1/users/verify-vendor-token")
    .set("User-Agent", UA)
    .send({ token: linkToken });
  expect(res.status).toBe(200);
  expect(res.body.data.is_guest).toBe(true);
  return res.body.data.token;
}

async function asGuest(vendorId, rfqNo) {
  const token = await guestTokenFor(vendorId, rfqNo);
  const agent = await boundRequest(await buildTestApp());
  // Synchronous: a supertest request is a thenable, so it must not be returned from an async fn.
  const call = (method) => (path) => agent[method](path).set({ Authorization: `Bearer ${token}`, "User-Agent": UA });
  return { get: call("get"), post: call("post"), patch: call("patch"), delete: call("delete") };
}

const expectGuestRefusal = (res) => {
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ status: 0, reason: "GUEST_SESSION" });
};

describe("a guest session never gets network or account power", () => {
  it("requireOrgAdmin routes (org settings, people, seats, entities) refuse a principal's guest session", async () => {
    const memberId = (await db.one(`SELECT id FROM tbl_vendor_org_members WHERE org_id = $1`, [ORG])).id;
    const guest = await asGuest(HQ);

    expectGuestRefusal(await (guest.get(`${BASE}/org`)));
    expectGuestRefusal(await (guest.patch(`${BASE}/org`)).send({ name: "Hijacked" }));
    expectGuestRefusal(
      await (guest.post(`${BASE}/members`)).send({ email: "attacker@example.com", name: "Attacker", role: "ORG_ADMIN" })
    );
    expectGuestRefusal(await (guest.patch(`${BASE}/members/${memberId}`)).send({ status: "DISABLED" }));
    expectGuestRefusal(await (guest.post(`${BASE}/seats/pay`)).send({ seat_ids: [1] }));
    expectGuestRefusal(
      await (guest.post(`${BASE}/seats/verify-payment`)).send({
        razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s",
      })
    );
    expectGuestRefusal(await (guest.patch(`${BASE}/entities/${BRANCH}`)).send({ status: "SUSPENDED" }));

    const org = await db.one(`SELECT name FROM tbl_vendor_orgs WHERE id = $1`, [ORG]);
    expect(org.name).toBe("Guest Test Network");
    expect(await db.any(`SELECT 1 FROM tbl_users WHERE lower(email) = 'attacker@example.com'`)).toHaveLength(0);
    const branch = await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH]);
    expect(branch.status).toBe("ACTIVE");

    // The same account logged in normally keeps its admin power.
    expect((await (await httpClient(HQ)).get(`${BASE}/org`)).status).toBe(200);
  });

  it("switch-entity is refused, so a guest token is never re-minted without its guest claim", async () => {
    const guest = await asGuest(HQ);
    const res = await (guest.post(`${BASE}/switch-entity`)).send({ entity_vendor_id: BRANCH });
    expectGuestRefusal(res);
    expect(res.body.data).toBeUndefined();
  });

  it("org create is refused to a no-org vendor's guest session", async () => {
    const guest = await asGuest(LONE);
    expectGuestRefusal(await (guest.post(`${BASE}/org`)).send({ name: "Squatted Network" }));
    expect(await db.any(`SELECT 1 FROM tbl_vendor_orgs WHERE principal_vendor_id = $1`, [LONE])).toHaveLength(0);
  });

  it("link-invite accept and decline are refused; the invite stays PENDING", async () => {
    const { id } = await db.one(
      `INSERT INTO tbl_vendor_org_link_invites
         (org_id, target_vendor_id, relationship, addressed_by, token_hash, status, expires_at, created_by)
       VALUES ($1, $2, 'BRANCH', 'EMAIL', md5(random()::text), 'PENDING', now() + interval '7 days', $3)
       RETURNING id`,
      [ORG, LONE, HQ]
    );
    const guest = await asGuest(LONE);
    expectGuestRefusal(await (guest.post(`${BASE}/link-invites/${id}/accept`)).send({}));
    expectGuestRefusal(await (guest.post(`${BASE}/link-invites/${id}/decline`)).send({}));
    expect((await db.one(`SELECT status FROM tbl_vendor_org_link_invites WHERE id = $1`, [id])).status).toBe("PENDING");
    expect(await db.any(`SELECT 1 FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [LONE])).toHaveLength(0);
  });

  it("entity leave is refused to the member entity's guest session", async () => {
    const guest = await asGuest(BRANCH);
    expectGuestRefusal(await (guest.post(`${BASE}/entities/self/leave`)).send({}));
    const row = await db.one(`SELECT status FROM tbl_vendor_org_entities WHERE vendor_id = $1`, [BRANCH]);
    expect(row.status).toBe("ACTIVE");
  });

  it("change-password is refused to every guest session, networked or not", async () => {
    for (const vendorId of [LONE, HQ]) {
      const guest = await asGuest(vendorId);
      const res = await (guest.post("/api/v1/users/change-password")).send({
        password: "Taken@9876",
        confirm_password: "Taken@9876",
      });
      expectGuestRefusal(res);
      const { password } = await db.one(`SELECT password FROM tbl_users WHERE id = $1`, [vendorId]);
      expect(password).toBe(PASSWORD_HASH);
      await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1`, [vendorId]);
    }
    // A normal session still changes its password.
    const ok = await (await httpClient(LONE)).post("/api/v1/users/change-password").send({
      password: "Fresh@9876",
      confirm_password: "Fresh@9876",
    });
    expect(ok.status).toBe(200);
  });
});

describe("a guest session keeps exactly what the emailed link was for", () => {
  it("views the RFQ and submits a quote", async () => {
    const rfq = await openRfqFor(HQ);
    const guest = await asGuest(HQ, rfq.rfq_no);

    expect((await guest.get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}`)).status).toBe(200);

    const quote = await (guest.post("/api/v1/rfq/quote/create")).send({
      rfq_id: rfq.rfq_id,
      rfq_no: rfq.rfq_no,
      status: 1,
      products: [
        {
          product_id: VARIANT,
          product_name: "VN product",
          unit_price: 100,
          tax: 18,
          total_price: 0,
          comment: "",
          delivery_period: "7",
          quantity: "10",
          variant: 0,
          tax_mode: "percentage",
          other_charges: [],
          document_files: [],
        },
      ],
      globalPaymentTerms: "",
      globalComment: "",
      global_payment_term_list: [],
      term_and_condition_files: [],
      vendorGSTIN: "",
      global_charges: [],
    });
    expect(quote.status).toBe(200);
    const rows = await db.any(`SELECT created_by FROM tbl_quotes WHERE rfq_id = $1`, [rfq.rfq_id]);
    expect(rows.map((r) => r.created_by)).toEqual([HQ]);
  });
});
