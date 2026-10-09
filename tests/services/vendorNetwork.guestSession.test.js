// Guest sessions (security audit H1, Task 23 S1). The emailed RFQ link is exchanged by
// POST /users/verify-vendor-token for a 30-minute JWT carrying `guest: true`. Whoever
// holds the link holds that session, so it may view, quote and regret on the RFQ and
// nothing else: every network/account route answers 403 { reason: 'GUEST_SESSION' }.
// Pattern B: committed fixtures (ids 95561..95569), removed in afterEach. Every call
// is real HTTP with the real token minted by the real endpoint.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import bcrypt from "bcryptjs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { buildTestApp } from "../setup/app.js";
import { boundRequest, httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import noLogin from "../../app/middleware/noLogin.js";
import { isGuestSession } from "../../app/helper/guestSession.js";
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
  return { get: call("get"), post: call("post"), put: call("put"), patch: call("patch"), delete: call("delete") };
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

describe("fix round 1: a guest session can never become a permanent login", () => {
  it("update-user-detail: a guest changing the email or mobile is 403 and writes nothing; unchanged identity still saves", async () => {
    await db.none(`UPDATE tbl_users SET mobile = '9811100000' WHERE id = ANY($1::int[])`, [[LONE, HQ]]);
    for (const vendorId of [LONE, HQ]) {
      const guest = await asGuest(vendorId);
      const email = `vn-guest-${vendorId}@example.com`;
      const takeover = await guest.put("/api/v1/users/update-user-detail").send({ name: "X", email: "attacker@example.com" });
      expectGuestRefusal(takeover);
      expectGuestRefusal(await guest.put("/api/v1/users/update-user-detail").send({ email, mobile: "+91-9000000001" }));
      expect(await db.one(`SELECT name, email, mobile FROM tbl_users WHERE id = $1`, [vendorId])).toEqual({
        name: `VN Guest ${vendorId}`,
        email,
        mobile: "9811100000",
      });
      // The quote flow's profile save (same identity, '+91-' formatted) is not a change.
      const same = await guest.put("/api/v1/users/update-user-detail").send({ name: "Renamed", email: email.toUpperCase(), mobile: "+91-9811100000" });
      expect(same.status).toBe(200);
      await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1`, [vendorId]);
    }
    // A normal session's email change behaves exactly as before.
    const own = await (await httpClient(LONE)).put("/api/v1/users/update-user-detail").send({ email: "Lone-New@Example.com", mobile: "9800000000" });
    expect(own.status).toBe(200);
    expect(await db.one(`SELECT email, mobile FROM tbl_users WHERE id = $1`, [LONE])).toEqual({ email: "lone-new@example.com", mobile: "9800000000" });
  });

  it("update-company-detail is refused to a guest; nothing is written", async () => {
    const guest = await asGuest(LONE);
    expectGuestRefusal(await guest.put("/api/v1/users/update-company-detail").send({ company_name: "Hijacked", gstin: "27ZZZZZ9999Z1Z5" }));
    expect((await db.one(`SELECT company_name, gstin FROM tbl_company WHERE id = $1`, [LONE]))).toEqual({ company_name: `VN Guest ${LONE}`, gstin: null });
  });

  it("contact / credential side routes refuse a guest before validating anything (SPOC, locations, push, profile image)", async () => {
    const guest = await asGuest(LONE);
    expectGuestRefusal(await guest.post("/api/v1/users/add-spoc").send({}));
    expectGuestRefusal(await guest.put("/api/v1/users/update-spoc/1").send({}));
    expectGuestRefusal(await guest.delete("/api/v1/users/delete-spoc/1"));
    expectGuestRefusal(await guest.post("/api/v1/users/add-buyer-vendor-location").send({}));
    expectGuestRefusal(await guest.put("/api/v1/users/update-buyer-vendor-location").send({}));
    expectGuestRefusal(await guest.delete("/api/v1/users/delete-buyer-vendor-location/1"));
    expectGuestRefusal(await guest.post("/api/v1/users/map-spoc-location").send({}));
    expectGuestRefusal(await guest.post("/api/v1/users/notifications/push-subscribe").send({ endpoint: "https://push.example/x" }));
    expectGuestRefusal(await guest.delete("/api/v1/users/notifications/push-subscribe").send({}));
    expectGuestRefusal(await guest.post("/api/v1/users/update-profile-image").send({}));
  });

  it("routing respond is refused to the assignee entity's guest session", async () => {
    const { id } = await db.one(
      `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, assigned_vendor_id, status)
       VALUES ($1, 'ARC_HOTEL', 1, $2, 'PENDING') RETURNING id`,
      [ORG, BRANCH]
    );
    const guest = await asGuest(BRANCH);
    expectGuestRefusal(await guest.post(`${BASE}/routing/${id}/respond`).send({ decision: "ACCEPT" }));
    expect((await db.one(`SELECT status FROM tbl_vendor_routing_assignments WHERE id = $1`, [id])).status).toBe("PENDING");
  });

  it("refresh-token: refused to a guest and for any user_id but the caller's own; .env is never touched", async () => {
    const envPath = path.resolve(process.cwd(), ".env");
    const fingerprint = () =>
      fs.existsSync(envPath) ? crypto.createHash("sha256").update(fs.readFileSync(envPath)).digest("hex") : "absent";
    const before = fingerprint();

    const guest = await asGuest(LONE);
    expectGuestRefusal(await guest.post("/api/v1/users/refresh-token").send({ user_id: LONE }));
    const other = await (await httpClient(LONE)).post("/api/v1/users/refresh-token").send({ user_id: HQ });
    expect(other.status).toBe(403);
    expect(other.body.status).toBe(0);
    const missing = await (await httpClient(LONE)).post("/api/v1/users/refresh-token").send({});
    expect(missing.status).toBe(403);

    expect(fingerprint()).toBe(before);
  });
});

describe("fix round 1: the ?token= path of vendorTokenOrJwt", () => {
  /** The real middleware, echoing whether the request is a guest session. */
  async function probe() {
    const app = express();
    app.set("trust proxy", 1);
    app.get("/probe", noLogin.vendorTokenOrJwt, (req, res) => res.json({ id: req.user.id, guest: isGuestSession(req) }));
    return boundRequest(app);
  }

  it("marks the request as a guest session (a JWT login is not one)", async () => {
    const linkToken = "4" + String(LONE).padStart(17, "0");
    await db.none(`INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no) VALUES ($1, $2, 1)`, [linkToken, LONE]);
    const agent = await probe();
    const viaLink = await agent.get(`/probe?token=${linkToken}`).set("X-Forwarded-For", "203.0.113.70");
    expect(viaLink.status).toBe(200);
    expect(viaLink.body).toEqual({ id: LONE, guest: true });

    const client = await httpClient(LONE);
    const viaJwt = await agent.get("/probe").set(client.headers);
    expect(viaJwt.body).toEqual({ id: LONE, guest: false });
  });

  it("counts invalid tokens toward the same limit: 429 after 20 from one client; a malformed token is 400, not 500", async () => {
    const res0 = await (await httpClient(null)).get("/api/v1/users/get-profile?token=abc").set("X-Forwarded-For", "203.0.113.71");
    expect(res0.status).toBe(400);
    const agent = (await httpClient(null));
    for (let i = 1; i < 20; i++) {
      const r = await agent.get(`/api/v1/users/get-profile?token=${100000000000000000n + BigInt(i)}`).set("X-Forwarded-For", "203.0.113.71");
      expect(r.status).toBe(400);
    }
    expect((await agent.get("/api/v1/users/get-profile?token=100000000000000099").set("X-Forwarded-For", "203.0.113.71")).status).toBe(429);
  });
});

describe("fix round 1: 18-digit tokens round-trip unchanged (int8 as a string end to end)", () => {
  it("a token above Number.MAX_SAFE_INTEGER verifies to its own vendor and is stored exactly", async () => {
    const token = "987654321987654321"; // > 2^53: a JS number would round it
    expect(Number.isSafeInteger(Number(token))).toBe(false);
    await db.none(`INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no) VALUES ($1, $2, 1)`, [token, LONE]);
    const stored = await db.one(`SELECT token FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = $1`, [LONE]);
    expect(stored.token).toBe(token); // pg returns int8 as a string (no type parser for OID 20)

    const agent = await boundRequest(await buildTestApp());
    const res = await agent.post("/api/v1/users/verify-vendor-token").set({ "User-Agent": UA, "X-Forwarded-For": "203.0.113.80" }).send({ token });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(LONE);
    // Its neighbours (what float rounding would produce) are not it.
    const near = await agent.post("/api/v1/users/verify-vendor-token").set({ "User-Agent": UA, "X-Forwarded-For": "203.0.113.80" }).send({ token: "987654321987654320" });
    expect(near.status).toBe(400);
  });
});

describe("fix round 2: guests cannot sign, decline or clarify ARC contracts and addenda", () => {
  const ARC = "/api/v1/arc-v2/vendor";
  const routes = [
    "/contracts/1/otp/request",
    "/contracts/1/otp/verify",
    "/contracts/1/clarification",
    "/contracts/1/decline",
    "/addendums/1/otp/request",
    "/addendums/1/otp/verify",
    "/addendums/1/decline",
  ];

  it("every ARC sign / decline / clarify route answers a guest 403 GUEST_SESSION", async () => {
    const guest = await asGuest(HQ);
    for (const route of routes) {
      const res = await guest.post(`${ARC}${route}`).send({ otp: "123456", reason: "x", note: "x" });
      expect([route, res.status, res.body.reason]).toEqual([route, 403, "GUEST_SESSION"]);
    }
  });

  it("a normal vendor session is not refused as a guest (it reaches the handler)", async () => {
    const client = await httpClient(HQ);
    for (const route of routes) {
      const res = await client.post(`${ARC}${route}`).send({});
      expect(res.body.reason).not.toBe("GUEST_SESSION");
    }
  });
});
