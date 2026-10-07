// Vendor Networks task 20 / D1: a network member is covered by its org's subscription
// plus its own seat (spec §5.1, §5.2), and the vendor-facing subscription surfaces say
// so instead of telling it to "Subscribe".
//
//   - GET /hospitality/vendor/subscription-status and /vendor/subscription-summary carry
//     `covered_by_network` for a non-principal member; the key is ABSENT for a vendor in
//     no org and for the principal (byte-identical responses, spec §10.1);
//   - an expired seat or a SUSPENDED entity is reported as not covered, and the
//     subscription gate still refuses it (no loosening);
//   - members cannot renew / preview / modify / extend a subscription (NETWORK_MEMBER);
//   - POST /entities inherits the principal's is_hospitality, so the new entity is
//     evaluated by the hospitality gate and get-profile over the org's pooled subscription.
//
// Pattern B (commit + cleanup). Fixture ids 95541..95549.

import { describe, it, expect, afterEach, afterAll, beforeAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
  moveApiSequencesPastFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { grantVendorHotelSubs, grantVendorCategorySub } from "../helpers/arcGroupSeed.js";

const P = 95541; // principal, hospitality, subscribed
const M = 95542; // BRANCH member, hospitality, no subscription of its own
const LONE = 95543; // hospitality vendor in no org, subscribed
const PERSON = 95544; // type-11 ENTITY_MEMBER of M
const ORG = 95541;

const H1 = IDS.hotels.A1;
const CAT = TEST_CATEGORIES.beverages;
const STATUS = "/api/v1/hospitality/vendor/subscription-status";
const SUMMARY = "/api/v1/hospitality/vendor/subscription-summary";
const PROFILE = "/api/v1/users/get-profile";

// The data keys of subscription-status as they were before networks (pinned).
const STATUS_KEYS = ["can_renew", "has_active_subscription", "has_pending", "is_expired", "subscription"];
const SUMMARY_KEYS = ["available_actions", "payment_history", "status", "subscription"];

const savedFee = process.env.NETWORK_SEAT_FEE_INR;

beforeAll(() => moveApiSequencesPastFixtures());

afterEach(async () => {
  if (savedFee === undefined) delete process.env.NETWORK_SEAT_FEE_INR;
  else process.env.NETWORK_SEAT_FEE_INR = savedFee;
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id BETWEEN 95541 AND 95549`);
  await db.none(
    `DELETE FROM tbl_vendor_hotel_category_subscription
      WHERE vendor_id IN (SELECT e.vendor_id FROM tbl_vendor_org_entities e WHERE e.org_id = $1)`,
    [ORG]
  );
  await cleanupVendorNetworkFixtures();
});

afterAll(closeDb);

function fyEnd() {
  const now = new Date();
  const year = now.getUTCMonth() >= 3 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return `${year}-03-31`;
}

async function vendor(id, { hospitality = 1, name = `VN Cov ${id}` } = {}) {
  await seedVendorEntity({ id, companyId: id, name, email: `vn-cov-${id}@example.com` });
  await db.none(`UPDATE tbl_company SET is_hospitality = $2 WHERE id = $1`, [id, hospitality]);
}

async function subscribe(vendorId) {
  await grantVendorCategorySub(vendorId, CAT);
  await grantVendorHotelSubs([vendorId], [H1]);
}

/** P (subscribed principal) + M (ACTIVE seated BRANCH, nothing of its own) + PERSON acting for M. */
async function network({ entityStatus = "ACTIVE" } = {}) {
  await vendor(P, { name: "VN Cov HQ" });
  await vendor(M);
  await subscribe(P);
  await seedOrg({ id: ORG, principalVendorId: P, name: "VN Cov Network" });
  await addEntity({ orgId: ORG, vendorId: M, status: entityStatus });
  await seedPerson({ id: PERSON, email: "vn-cov-person@example.com", name: "VN Cov Person" });
  await addMember({ orgId: ORG, personId: PERSON, entityVendorId: M, role: "ENTITY_MEMBER" });
}

const subValidUntil = async (vendorId) =>
  (
    await db.one(
      `SELECT MAX(end_date)::text AS d FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`,
      [vendorId]
    )
  ).d;

describe("subscription-status / summary for a network member (D1)", () => {
  it("a seated ACTIVE member is covered by its network: covered_by_network names the org, principal and seat", async () => {
    await network();
    const expected = {
      org_id: ORG,
      org_name: "VN Cov Network",
      principal_vendor_id: P,
      principal_name: "VN Cov HQ",
      entity_status: "ACTIVE",
      subscription_active: true,
      subscription_valid_until: await subValidUntil(P),
      seat_active: true,
      seat_valid_until: fyEnd(),
      seat_expired_on: null,
      covered: true,
    };

    // The member's own login and a person acting for it see the same thing.
    for (const client of [await httpClient(M), await httpClient(PERSON)]) {
      const status = await client.get(STATUS);
      expect(status.status).toBe(200);
      expect(status.body.data.has_active_subscription).toBe(true);
      expect(status.body.data.subscription).toBeNull(); // nothing of its own
      expect(status.body.data.covered_by_network).toEqual(expected);

      const summary = await client.get(SUMMARY);
      expect(summary.status).toBe(200);
      expect(summary.body.data.covered_by_network).toEqual(expected);
    }

    // The org admin switched INTO the member acts as a non-principal entity too.
    const adminAsM = await (await httpClient(P, { ent: M })).get(STATUS);
    expect(adminAsM.body.data.covered_by_network).toEqual(expected);
  });

  it("no-org vendor and the principal: no covered_by_network key, responses keep their pre-network shape", async () => {
    await network();
    await vendor(LONE);
    await subscribe(LONE);

    for (const id of [LONE, P]) {
      const client = await httpClient(id);
      const status = await client.get(STATUS);
      expect(status.status).toBe(200);
      expect(Object.keys(status.body.data).sort()).toEqual(STATUS_KEYS);
      expect(status.body.data.has_active_subscription).toBe(true);
      expect(status.body.data.subscription).not.toBeNull();

      const summary = await client.get(SUMMARY);
      expect(Object.keys(summary.body.data).sort()).toEqual(SUMMARY_KEYS);
    }
  });

  it("an expired seat (fee > 0) is reported not covered, and the subscription gate still refuses NO_SEAT", async () => {
    await network();
    await db.none(
      `UPDATE tbl_vendor_network_seats SET status = 'expired', end_date = CURRENT_DATE - 1 WHERE entity_vendor_id = $1`,
      [M]
    );
    process.env.NETWORK_SEAT_FEE_INR = "500";
    const yesterday = (await db.one(`SELECT (CURRENT_DATE - 1)::text AS d`)).d;

    const client = await httpClient(M);
    const cov = (await client.get(STATUS)).body.data.covered_by_network;
    expect(cov).toMatchObject({
      seat_active: false,
      seat_valid_until: null,
      seat_expired_on: yesterday,
      subscription_active: true,
      covered: false,
    });

    const gated = await client.get("/api/v1/rfq/get-rfqs?page=1&limit=10&tech_eval=false");
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe("NO_SEAT");
  });

  it("a SUSPENDED member is reported not covered (no pooled subscription)", async () => {
    await network({ entityStatus: "SUSPENDED" });
    const cov = (await (await httpClient(M)).get(STATUS)).body.data.covered_by_network;
    expect(cov).toMatchObject({ entity_status: "SUSPENDED", subscription_active: false, covered: false });
  });
});

describe("members cannot buy or change the org's subscription (D1)", () => {
  const MUTATIONS = [
    "/api/v1/hospitality/renew-subscription",
    "/api/v1/hospitality/vendor/subscription/preview",
    "/api/v1/hospitality/vendor/subscription/modify",
    "/api/v1/hospitality/vendor/subscription/extend",
  ];

  it("a member (own login, person, admin switched in) gets 403 NETWORK_MEMBER; principal and no-org pass the guard", async () => {
    await network();
    await vendor(LONE);

    for (const client of [await httpClient(M), await httpClient(PERSON), await httpClient(P, { ent: M })]) {
      for (const path of MUTATIONS) {
        const res = await client.post(path).send({});
        expect([path, res.status, res.body.reason]).toEqual([path, 403, "NETWORK_MEMBER"]);
        expect(res.body.message).toMatch(/VN Cov Network/);
      }
    }
    // Only the endpoints that never reach Razorpay: renew answers "already active" or
    // "nothing to renew", preview is a pure read. modify/extend would create an order.
    for (const id of [P, LONE]) {
      const client = await httpClient(id);
      for (const path of MUTATIONS.slice(0, 2)) {
        const res = await client.post(path).send({});
        expect([path, res.body.reason]).toEqual([path, undefined]);
      }
    }
  });
});

describe("POST /entities inherits the principal's hospitality flag (D1)", () => {
  async function createBranch(admin, n) {
    const { city_id, state_id } = await db.one(
      `SELECT c.id AS city_id, c.state_id FROM tbl_location_cities c
         JOIN tbl_location_states s ON s.id = c.state_id AND s.country_id = 1
        ORDER BY c.id LIMIT 1`
    );
    const res = await admin.post("/api/v1/vendor-network/entities").send({
      company_name: `VN Cov Branch ${n}`,
      gstin: `27ABCDE${String(1230 + n)}F1Z5`,
      email: `vn-cov-branch-${n}@example.com`,
      state_id,
      city_id,
      relationship: "BRANCH",
    });
    expect(res.status).toBe(201);
    return res.body.data.vendor_id;
  }

  const companyFlag = async (vendorId) =>
    (
      await db.one(
        `SELECT c.is_hospitality FROM tbl_users u JOIN tbl_company c ON c.id = u.company_id WHERE u.id = $1`,
        [vendorId]
      )
    ).is_hospitality;

  it("a hospitality principal's new branch is a hospitality vendor covered by the pooled subscription", async () => {
    await vendor(P, { name: "VN Cov HQ" });
    await subscribe(P);
    await seedOrg({ id: ORG, principalVendorId: P, name: "VN Cov Network" });

    const branch = await createBranch(await httpClient(P), 1);
    expect(await companyFlag(branch)).toBe(1);

    const profile = await (await httpClient(branch)).get(PROFILE);
    expect(profile.status).toBe(200);
    expect(profile.body.data.has_valid_hospitality_subscription).toBe(true);
    expect((await (await httpClient(branch)).get(STATUS)).body.data.covered_by_network.covered).toBe(true);
  });

  it("a non-hospitality principal's new branch stays non-hospitality (0)", async () => {
    await vendor(P, { hospitality: 0 });
    await seedOrg({ id: ORG, principalVendorId: P, name: "VN Cov Network" });
    const branch = await createBranch(await httpClient(P), 2);
    expect(await companyFlag(branch)).toBe(0);
  });
});

// Fix round 1 / review minor 5: the remaining entity states.
describe("covered_by_network for an INVITED entity and a lapsed org subscription", () => {
  it("an INVITED entity is not covered (no pooled subscription)", async () => {
    await network({ entityStatus: "INVITED" });
    const cov = (await (await httpClient(M)).get(STATUS)).body.data.covered_by_network;
    expect(cov).toMatchObject({ entity_status: "INVITED", subscription_active: false, covered: false });
  });

  it("an ACTIVE, seated member of a network whose subscription lapsed is not covered", async () => {
    await network();
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [P]);
    const cov = (await (await httpClient(M)).get(STATUS)).body.data.covered_by_network;
    expect(cov).toMatchObject({
      entity_status: "ACTIVE",
      seat_active: true,
      seat_valid_until: fyEnd(),
      subscription_active: false,
      subscription_valid_until: null,
      covered: false,
    });
  });
});

// Fix round 1 / review Important 1: the public, user_key-authenticated purchase path.
describe("POST /hospitality/subscription-payment (user_key, no JWT)", () => {
  const PAY = "/api/v1/hospitality/subscription-payment";
  const userKeyOf = async (userId) => (await (await httpClient(userId)).get(PROFILE)).body.data.user_key;
  const rowsOf = async (vendorId) => ({
    payments: Number((await db.one(`SELECT count(*) FROM tbl_vendor_payments WHERE vendor_id = $1`, [vendorId])).count),
    subs: Number(
      (await db.one(`SELECT count(*) FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [vendorId])).count
    ),
  });
  // Hotels only: a zero total, so the free path writes rows without calling Razorpay.
  const body = (user_key) => ({ user_key, categories: [], subcategories: [], hotels: [H1] });

  it("a member entity's user_key (own login or a person acting for it, any live status) gets 403 and writes nothing", async () => {
    await network();
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [P]); // org lapsed
    const anon = await httpClient(null);

    for (const keyFrom of [M, PERSON]) {
      const res = await anon.post(PAY).send(body(await userKeyOf(keyFrom)));
      expect([res.status, res.body.reason]).toEqual([403, "NETWORK_MEMBER"]);
    }
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE vendor_id = $1`, [M]);
    const suspended = await anon.post(PAY).send(body(await userKeyOf(M)));
    expect([suspended.status, suspended.body.reason]).toEqual([403, "NETWORK_MEMBER"]);

    expect(await rowsOf(M)).toEqual({ payments: 0, subs: 0 });
  });

  it("the principal and a vendor in no network keep today's behaviour", async () => {
    await network();
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = $1`, [P]);
    await vendor(LONE);
    const anon = await httpClient(null);

    // They pass the guard and reach the purchase logic, which records the zero-total
    // payment. (That free path then fails today with a 400 of its own: it stores the
    // payment row object as payment_id. Pre-existing and out of this task's scope; the
    // assertion only pins that no network refusal happens.)
    for (const id of [P, LONE]) {
      const res = await anon.post(PAY).send(body(await userKeyOf(id)));
      expect(res.status).not.toBe(403);
      expect(res.body.reason).toBeUndefined();
      expect((await rowsOf(id)).payments).toBe(1);
    }
  });
});
