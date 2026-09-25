// ARC vendor eligibility — one resolver, the RFQ rule, per-hotel coverage.
//
// A vendor qualifies for an ARC only with BOTH a category subscription and a
// hotel subscription (the rule RFQ already uses). ARC used to accept either,
// so a category subscription alone invited a vendor to every hotel's rate
// contracts. For a group ARC the resolver also reports WHICH covered hotels a
// vendor may quote for, and which of those need a renewal before the vendor can
// submit — so the vendor learns that when opening the invitation, not at the
// final step.
//
// Product-level: real Postgres; the HTTP cases run the full middleware chain.

import { db } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import {
  grantVendorHotelSubs,
  grantVendorCategorySub,
  revokeVendorSubs,
  markAsVendors,
  restoreUserTypes,
} from "../../helpers/arcGroupSeed.js";
import {
  resolveArcVendorCoverage,
  vendorCanSubmitForHotels,
} from "../../../app/helper/arc_v2/arcEligibility.js";

const { A1, A2, A3, B1 } = IDS.hotels;
const ALPHA = IDS.users.vendor_alpha;     // beverages category sub, active
const EPSILON = IDS.users.vendor_epsilon; // no beverages category sub
const BEVERAGES = TEST_CATEGORIES.beverages;

const onlyFixtureVendors = (rows) => rows.filter((r) => [ALPHA, EPSILON].includes(Number(r.id)));
const find = (rows, id) => rows.find((r) => Number(r.id) === id);

describe("ARC vendor coverage — category AND hotel subscription", () => {
  let userTypesBefore;
  const subIds = [];

  beforeAll(async () => {
    userTypesBefore = await markAsVendors([ALPHA, EPSILON]);
  });

  afterEach(async () => {
    await revokeVendorSubs(subIds.splice(0));
  });

  afterAll(async () => {
    await restoreUserTypes(userTypesBefore);
  });

  test("a category subscription alone does not qualify a vendor for a hotel", async () => {
    const rows = await resolveArcVendorCoverage({ category_id: BEVERAGES, hotel_ids: [A1] });
    expect(find(rows, ALPHA)).toBeUndefined();
  });

  test("category + hotel subscription qualifies the vendor for that hotel", async () => {
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A1])));
    const rows = await resolveArcVendorCoverage({ category_id: BEVERAGES, hotel_ids: [A1] });
    expect(find(rows, ALPHA)).toMatchObject({ hotel_ids: [A1], renewal_needed_hotel_ids: [] });
  });

  test("coverage lists only the covered hotels the vendor subscribes to, and flags expired ones", async () => {
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A1])));
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A2], { status: "expired" })));
    const rows = await resolveArcVendorCoverage({ category_id: BEVERAGES, hotel_ids: [A1, A2, A3] });
    expect(find(rows, ALPHA)).toMatchObject({ hotel_ids: [A1, A2], renewal_needed_hotel_ids: [A2] });
  });

  test("an expired category subscription flags every covered hotel for renewal", async () => {
    subIds.push(await grantVendorCategorySub(EPSILON, BEVERAGES, { status: "expired" }));
    subIds.push(...(await grantVendorHotelSubs([EPSILON], [A1, A2])));
    const rows = await resolveArcVendorCoverage({ category_id: BEVERAGES, hotel_ids: [A1, A2] });
    expect(find(rows, EPSILON)).toMatchObject({ hotel_ids: [A1, A2], renewal_needed_hotel_ids: [A1, A2] });
  });

  test("a hotel subscription without the category subscription does not qualify", async () => {
    subIds.push(...(await grantVendorHotelSubs([EPSILON], [A1])));
    const rows = onlyFixtureVendors(await resolveArcVendorCoverage({ category_id: BEVERAGES, hotel_ids: [A1] }));
    expect(find(rows, EPSILON)).toBeUndefined();
  });

  test("submission needs an ACTIVE category and an ACTIVE hotel subscription for at least one hotel", async () => {
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A1])));
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A2], { status: "expired" })));
    expect(await vendorCanSubmitForHotels(ALPHA, { category_id: BEVERAGES, hotel_ids: [A2] })).toBe(false);
    expect(await vendorCanSubmitForHotels(ALPHA, { category_id: BEVERAGES, hotel_ids: [A1, A2] })).toBe(true);
  });
});

describe("GET /arc-v2/eligible-vendors — group coverage over HTTP", () => {
  let userTypesBefore;
  let buyerTypesBefore;
  const subIds = [];

  beforeAll(async () => {
    userTypesBefore = await markAsVendors([ALPHA]);
    buyerTypesBefore = await db.any(
      `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
      [[IDS.users.a1_proc_buyer, IDS.users.companyA_admin]]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
      [[IDS.users.a1_proc_buyer, IDS.users.companyA_admin]]);
    subIds.push(...(await grantVendorHotelSubs([ALPHA], [A1, A3])));
  });

  afterAll(async () => {
    await revokeVendorSubs(subIds);
    await restoreUserTypes(userTypesBefore);
    await restoreUserTypes(buyerTypesBefore);
  });

  test("a buyer cannot ask about a hotel outside their scope", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer); // A1 only
    const res = await client.get(`/api/v1/arc-v2/eligible-vendors?category_id=${BEVERAGES}&hotel_ids=${A1},${A3}`);
    expect(res.status).toBe(403);
  });

  test("hotels from different companies are rejected", async () => {
    const client = await httpClient(IDS.users.superAdmin);
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id = $1`, [IDS.users.superAdmin]);
    const res = await client.get(`/api/v1/arc-v2/eligible-vendors?category_id=${BEVERAGES}&hotel_ids=${A1},${B1}`);
    expect(res.status).toBe(400);
  });

  test("a company-wide buyer gets each vendor with the hotels it covers", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get(`/api/v1/arc-v2/eligible-vendors?category_id=${BEVERAGES}&hotel_ids=${A1},${A2},${A3}`);
    expect(res.status).toBe(200);
    expect(find(res.body.data.vendors, ALPHA)).toMatchObject({ hotel_ids: [A1, A3] });
  });

  test("the single-hotel form (hotel_id) keeps working", async () => {
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/arc-v2/eligible-vendors?category_id=${BEVERAGES}&hotel_id=${A1}`);
    expect(res.status).toBe(200);
    expect(find(res.body.data.vendors, ALPHA)).toMatchObject({ hotel_ids: [A1] });
  });
});
