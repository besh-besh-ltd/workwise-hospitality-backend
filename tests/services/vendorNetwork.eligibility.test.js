// Vendor Networks task 6: subscription and eligibility integration (spec §5.1, §5.2).
//
//   - the parent's subscription covers the network (hasValidPaidSubscription,
//     vendorCanSubmitForHotels evaluate over subscriptionHolderIdsFor);
//   - RFQ and ARC invites collapse to the org principal, so a linked legacy duplicate
//     (Daikin UP under Daikin HQ) never gets its own invite;
//   - requireActiveSubscription refuses a member entity without a seat (NO_SEAT);
//   - the RFQ vendor sync never deletes rows the routing engine added
//     (routed_from_vendor_id IS NOT NULL).
//
// A vendor in no org must see exactly today's results. Every "no-org" assertion below
// pins exact values, and the same suite was run against the pre-change code (see the
// task 6 report) where those assertions hold too.
//
// Pattern B (commit + cleanup): the functions under test query `db` directly.
// Fixture ids 95701..95719; RFQs come from makeRFQ and are removed in afterEach.

import { describe, it, expect, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import {
  seedVendorEntity,
  seedOrg,
  addEntity,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { grantVendorHotelSubs, grantVendorCategorySub, revokeVendorSubs } from "../helpers/arcGroupSeed.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";
import { resolveArcVendorCoverage, vendorCanSubmitForHotels } from "../../app/helper/arc_v2/arcEligibility.js";

const P = 95701; // principal (Daikin HQ)
const B = 95702; // legacy branch with its own subscriptions and variant mapping (Daikin UP)
const N = 95703; // no-org control, seeded exactly like B
const M = 95704; // member entity without any subscription
const ORG = 95701;

const CAT = TEST_CATEGORIES.beverages;
const H1 = IDS.hotels.A1;
const H2 = IDS.hotels.A2;
const BUYER = IDS.users.a1_proc_buyer;

const created = { subIds: [], mappingIds: [], rfqIds: [] };
const savedFee = process.env.NETWORK_SEAT_FEE_INR;

afterEach(async () => {
  if (savedFee === undefined) delete process.env.NETWORK_SEAT_FEE_INR;
  else process.env.NETWORK_SEAT_FEE_INR = savedFee;
  if (created.rfqIds.length) {
    const ids = created.rfqIds;
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(
      `DELETE FROM tbl_vendor_rfq_tokens_non_login
        WHERE rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($1::int[]))`,
      [ids]
    );
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
  }
  await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [created.mappingIds]);
  await revokeVendorSubs(created.subIds);
  await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id BETWEEN 95701 AND 95719`);
  await cleanupVendorNetworkFixtures();
  created.subIds = [];
  created.mappingIds = [];
  created.rfqIds = [];
});

afterAll(async () => {
  await closeDb();
});

let cachedVariantId;
async function variantId() {
  if (!cachedVariantId) {
    const v = await db.one(
      `SELECT pv.id FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pc.category_id = $1
        ORDER BY pv.id LIMIT 1`,
      [CAT]
    );
    cachedVariantId = Number(v.id);
  }
  return cachedVariantId;
}

async function vendor(id) {
  await seedVendorEntity({ id, companyId: id, name: `VN Elig ${id}`, email: `vn-elig-${id}@example.com` });
  await db.none(`UPDATE tbl_company SET is_hospitality = 1 WHERE id = $1`, [id]);
  await db.none(`UPDATE tbl_users SET mobile = $2 WHERE id = $1`, [id, `98000${id}`]);
}

async function mapVariant(vendorId) {
  const row = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $2, now(), now())
     RETURNING id`,
    [await variantId(), vendorId]
  );
  created.mappingIds.push(row.id);
}

async function subscribe(vendorId, hotelIds, { status = "active", category = true } = {}) {
  if (category) created.subIds.push(await grantVendorCategorySub(vendorId, CAT));
  created.subIds.push(...(await grantVendorHotelSubs([vendorId], hotelIds, { status })));
}

/** B and N: identical vendors, both eligible for the variant at H1. */
async function legacyPair() {
  await vendor(P);
  await vendor(B);
  await vendor(N);
  for (const id of [B, N]) {
    await mapVariant(id);
    await subscribe(id, [H1]);
  }
}

async function linkUnderP(vendorId, opts = {}) {
  if (!(await db.oneOrNone(`SELECT 1 FROM tbl_vendor_orgs WHERE id = $1`, [ORG]))) {
    await seedOrg({ id: ORG, principalVendorId: P, name: "VN Elig Org" });
  }
  await addEntity({ orgId: ORG, vendorId, ...opts });
}

async function openRfq() {
  const rfq = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1, title: "VN eligibility RFQ" });
  created.rfqIds.push(rfq.rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1)`,
    [rfq.rfq_id, await variantId()]
  );
  await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [
    rfq.rfq_id,
    H1,
    BUYER,
  ]);
  return rfq;
}

const rfqVendorRows = (rfqId) =>
  db.any(
    `SELECT user_id, routed_from_vendor_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1 ORDER BY user_id`,
    [rfqId]
  );

const eligibleIds = async () =>
  (await hospitalityModel.getEligibleVendorsForVariant(await variantId(), [H1])).map((r) => Number(r.vendor_id));

describe("RFQ eligibility collapses to the principal", () => {
  it("collapse dedupes linked entities", async () => {
    await legacyPair();

    const before = await eligibleIds();
    expect(before).toContain(B);
    expect(before).not.toContain(P);

    await linkUnderP(B);
    const after = await eligibleIds();
    expect(after).toContain(P);
    expect(after).not.toContain(B);
    expect(after.filter((id) => id === P)).toHaveLength(1);

    // Everyone else, the no-org control N included, is unchanged and in the same order.
    expect(after.filter((id) => id !== P)).toEqual(before.filter((id) => id !== B));
  });

  it("an independently eligible principal and its linked branch give ONE invite", async () => {
    await legacyPair();
    await mapVariant(P);
    await subscribe(P, [H1]);
    await linkUnderP(B);

    const ids = await eligibleIds();
    expect(ids.filter((id) => id === P)).toHaveLength(1);
    expect(ids).not.toContain(B);
  });
});

describe("a vendor in no org sees today's results", () => {
  const arcRow = (rows, id) => rows.find((r) => Number(r.id) === id);
  const expectedArc = (id) => ({
    id,
    name: `VN Elig ${id}`,
    email: `vn-elig-${id}@example.com`,
    mobile: `98000${id}`,
    hotel_ids: [H1, H2],
    renewal_needed_hotel_ids: [H2],
  });

  // Every value below is pinned, and this test passes unchanged on the pre-change
  // code too (task 6 report, RED run): the no-org answers are today's answers.
  it("no-org eligibility is unchanged, compared with a vendor seeded identically", async () => {
    await legacyPair();
    await subscribe(N, [H2], { status: "expired", category: false });
    await subscribe(B, [H2], { status: "expired", category: false });
    const rfq = await openRfq();
    const variant = await variantId();

    // B is N's twin; linking B into a network must not move any of N's answers.
    await linkUnderP(B);

    const rows = await hospitalityModel.getEligibleVendorsForVariant(variant, [H1]);
    expect(rows).toContainEqual({ vendor_id: N });
    expect(rows.filter((r) => r.vendor_id === N)).toHaveLength(1);

    const coverage = await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] });
    expect(arcRow(coverage, N)).toEqual(expectedArc(N));

    expect(await hospitalityModel.hasValidPaidSubscription(N)).toBe(true);
    await vendor(95705);
    expect(await hospitalityModel.hasValidPaidSubscription(95705)).toBe(false);

    expect(await vendorCanSubmitForHotels(N, { category_id: CAT, hotel_ids: [H1] })).toBe(true);
    expect(await vendorCanSubmitForHotels(N, { category_id: CAT, hotel_ids: [H2] })).toBe(false);

    const matching = await hospitalityModel.getMatchingOpenRfqsForVendor(N);
    expect(matching.map((r) => Number(r.rfq_id))).toContain(rfq.rfq_id);
    const inserted = await hospitalityModel.addVendorToRfq(N, rfq.rfq_id);
    expect(inserted).toEqual([{ product_variant_id: variant, variant: 1 }]);
    expect(await rfqVendorRows(rfq.rfq_id)).toEqual([{ user_id: N, routed_from_vendor_id: null }]);
    const again = await hospitalityModel.getMatchingOpenRfqsForVendor(N);
    expect(again.map((r) => Number(r.rfq_id))).not.toContain(rfq.rfq_id);

    const res = await (await httpClient(N)).get("/api/v1/rfq/get-rfqs?page=1&limit=10&tech_eval=false");
    expect(res.status).toBe(200);
  });

  it("linking one vendor changes no other vendor's rows, order included", async () => {
    await legacyPair();
    await subscribe(N, [H2], { status: "expired", category: false });
    await subscribe(B, [H2], { status: "expired", category: false });
    const variant = await variantId();

    const rowsBefore = await hospitalityModel.getEligibleVendorsForVariant(variant, [H1]);
    const coverageBefore = await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] });
    expect(arcRow(coverageBefore, B)).toEqual(expectedArc(B));

    await linkUnderP(B);

    const rowsAfter = await hospitalityModel.getEligibleVendorsForVariant(variant, [H1]);
    expect(rowsAfter.filter((r) => r.vendor_id !== P)).toEqual(rowsBefore.filter((r) => r.vendor_id !== B));
    expect(rowsAfter).toContainEqual({ vendor_id: P });

    const coverageAfter = await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] });
    expect(coverageAfter.filter((r) => Number(r.id) !== P)).toEqual(
      coverageBefore.filter((r) => Number(r.id) !== B)
    );
    // The principal row carries the principal's own identity fields.
    expect(arcRow(coverageAfter, P)).toEqual(expectedArc(P));
  });
});

describe("the parent's subscription covers the network; non-principals need a seat", () => {
  it("member without subscription is covered by the principal and gated by its seat", async () => {
    await vendor(P);
    await vendor(M);
    await subscribe(P, [H1]);

    expect(await hospitalityModel.hasValidPaidSubscription(M)).toBe(false);
    await linkUnderP(M); // ACTIVE, with an active seat
    expect(await hospitalityModel.hasValidPaidSubscription(M)).toBe(true);

    const path = "/api/v1/rfq/get-rfqs?page=1&limit=10&tech_eval=false";
    const asM = await httpClient(M);
    expect((await asM.get(path)).status).toBe(200);

    await db.none(`UPDATE tbl_vendor_network_seats SET status = 'pending' WHERE entity_vendor_id = $1`, [M]);

    // Fee 0: seats are free, so a pending seat still operates.
    process.env.NETWORK_SEAT_FEE_INR = "0";
    expect((await asM.get(path)).status).toBe(200);

    process.env.NETWORK_SEAT_FEE_INR = "500";
    const refused = await asM.get(path);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ status: 0, message: "Network seat required for this entity", code: "NO_SEAT" });

    // The principal never needs a seat, but acting FOR the unseated entity does.
    expect((await (await httpClient(P)).get(path)).status).toBe(200);
    const actingForM = await (await httpClient(P, { ent: M })).get(path);
    expect(actingForM.status).toBe(403);
    expect(actingForM.body.code).toBe("NO_SEAT");

    // An emailed-link token (no JWT, network never resolved) is gated too.
    const rfq = await openRfq();
    const token = 9570400000000 + Math.floor(Math.random() * 1000);
    await db.none(`INSERT INTO tbl_vendor_rfq_tokens_non_login (token, vendor_id, rfq_no) VALUES ($1, $2, $3)`, [
      token,
      M,
      rfq.rfq_no,
    ]);
    const viaToken = await (await httpClient(null)).get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}?token=${token}`);
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.code).toBe("NO_SEAT");

    // Spec §5.1: POs already addressed to the entity stay actionable without a seat:
    // dispatch and invoice pass the gate and reach the controller (no PO here).
    for (const route of ["/api/v1/po/markDispatched", "/api/v1/po/raiseInvoice"]) {
      const res = await asM.post(route).send({});
      expect(res.body.code).not.toBe("NO_SEAT");
      expect(res.status).not.toBe(403);
    }
  });

  it("a SUSPENDED member is not covered and cannot operate", async () => {
    await vendor(P);
    await vendor(M);
    await subscribe(P, [H1]);
    await linkUnderP(M, { status: "SUSPENDED" });

    expect(await hospitalityModel.hasValidPaidSubscription(M)).toBe(false);
    const res = await (await httpClient(M)).get("/api/v1/rfq/get-rfqs?page=1&limit=10&tech_eval=false");
    expect(res.status).toBe(403);
    expect(res.body.subscription_expired).toBe(true);
  });
});

describe("ARC coverage collapses to the principal", () => {
  it("unions hotel ids per principal", async () => {
    await vendor(P);
    await vendor(B);
    await subscribe(B, [H1]);
    await subscribe(P, [H2]);

    const before = await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] });
    expect(before.filter((r) => [P, B].includes(Number(r.id))).map((r) => [r.id, r.hotel_ids])).toEqual(
      expect.arrayContaining([
        [P, [H2]],
        [B, [H1]],
      ])
    );
    expect(await vendorCanSubmitForHotels(P, { category_id: CAT, hotel_ids: [H1] })).toBe(false);

    await linkUnderP(B);
    const after = await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] });
    const ours = after.filter((r) => [P, B].includes(Number(r.id)));
    expect(ours).toEqual([
      {
        id: P,
        name: `VN Elig ${P}`,
        email: `vn-elig-${P}@example.com`,
        mobile: `98000${P}`,
        hotel_ids: [H1, H2],
        renewal_needed_hotel_ids: [],
      },
    ]);
    // The principal submits on the network's subscriptions.
    expect(await vendorCanSubmitForHotels(P, { category_id: CAT, hotel_ids: [H1] })).toBe(true);
  });

  it("a hotel needs renewal only when no collapsed entity is fully active for it", async () => {
    await vendor(P);
    await vendor(B);
    await subscribe(B, [H1, H2], { status: "expired" });
    await subscribe(P, [H2]);
    await linkUnderP(B);

    const row = (await resolveArcVendorCoverage({ category_id: CAT, hotel_ids: [H1, H2] })).find(
      (r) => Number(r.id) === P
    );
    expect(row.hotel_ids).toEqual([H1, H2]);
    expect(row.renewal_needed_hotel_ids).toEqual([H1]);
  });
});

describe("RFQ vendor sync", () => {
  it("does not add a linked entity and never deletes routed rows", async () => {
    await legacyPair();
    await vendor(M);
    await linkUnderP(B);
    await linkUnderP(M);
    const rfq = await openRfq();
    const variant = await variantId();

    // A routing copy for member M (the routing engine's row, task 8).
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant, routed_from_vendor_id)
       VALUES ($1, $2, $3, 1, $4)`,
      [rfq.rfq_id, variant, M, P]
    );

    await hospitalityModel.recomputeVendorsForRfq(rfq.rfq_id, [H1]);
    let rows = await rfqVendorRows(rfq.rfq_id);
    let users = rows.map((r) => Number(r.user_id));
    expect(users).toContain(P);
    expect(users).toContain(N);
    expect(users).not.toContain(B);
    expect(rows).toContainEqual({ user_id: M, routed_from_vendor_id: P });

    // A hotel change that leaves no one eligible removes invites, never routed rows.
    await hospitalityModel.recomputeVendorsForRfq(rfq.rfq_id, [IDS.hotels.B2]);
    rows = await rfqVendorRows(rfq.rfq_id);
    expect(rows).toContainEqual({ user_id: M, routed_from_vendor_id: P });
    expect(rows.map((r) => Number(r.user_id))).not.toContain(P);

    // The non-destructive refresh (POST /rfq/refresh-vendors) adds the principal, not B.
    await hospitalityModel.addMissingVendorsForRfq(rfq.rfq_id, [H1]);
    rows = await rfqVendorRows(rfq.rfq_id);
    users = rows.map((r) => Number(r.user_id));
    expect(users).toContain(P);
    expect(users).not.toContain(B);
    expect(rows).toContainEqual({ user_id: M, routed_from_vendor_id: P });
  });

  it("open-RFQ auto-join by a linked entity invites the principal", async () => {
    await legacyPair();
    await linkUnderP(B);
    const rfq = await openRfq();

    const matching = await hospitalityModel.getMatchingOpenRfqsForVendor(B);
    expect(matching.map((r) => Number(r.rfq_id))).toContain(rfq.rfq_id);

    const res = await (await httpClient(B))
      .post("/api/v1/hospitality/vendor/join-open-rfqs")
      .send({ rfq_ids: [rfq.rfq_id] });
    expect(res.status).toBe(200);
    expect(res.body.data.joined_count).toBe(1);

    expect(await rfqVendorRows(rfq.rfq_id)).toEqual([{ user_id: P, routed_from_vendor_id: null }]);
    const tokens = await db.any(`SELECT vendor_id FROM tbl_vendor_rfq_tokens_non_login WHERE rfq_no = $1`, [
      rfq.rfq_no,
    ]);
    expect(tokens.map((t) => Number(t.vendor_id))).toEqual([P]);

    // The org is invited now, so the RFQ no longer matches for B (or P).
    const again = await hospitalityModel.getMatchingOpenRfqsForVendor(B);
    expect(again.map((r) => Number(r.rfq_id))).not.toContain(rfq.rfq_id);
  });
});
