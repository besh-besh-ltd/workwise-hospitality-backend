// Vendor Networks task 7: hotel location ids, coverage rules API and resolver (spec §3, §6.1).
//
//   - resolveHotelLocationIds mirrors the migration's vn_backfill_hotel_location_ids()
//     (unique normalised names only) and every hotel write keeps state_id/city_id in sync;
//   - the coverage decision: most specific rule wins, category-specific beats category-NULL,
//     EXCLUDE wins ties; a hotel without location ids is reached by HOTEL rules only;
//   - resolveCoverageCandidates ranks operable member entities (parity with entityCanOperate);
//   - /coverage routes are ORG_ADMIN only and validate every target id.
//
// Rule/decision tests are Pattern A (withTx, the functions take a runner). The world
// (org, entities, hotels) is committed in beforeAll; HTTP tests are Pattern B with cleanup.
// Fixture ids 95801..95849.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import {
  seedVendorEntity,
  seedOrg,
  addEntity,
  seedHotel,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { resolveHotelLocationIds } from "../../app/helper/hotelLocation.js";
import {
  resolveCoverageCandidates,
  entityCoversHotel,
  previewCoveredHotels,
  searchPreviewHotels,
} from "../../app/services/vendorNetwork/coverage.js";
import { entityCanOperate } from "../../app/services/vendorNetwork/actingContext.js";
import { findUnmatchedHotels, formatReport } from "../../scripts/vendor_networks/hotel_location_report.mjs";

const P = 95801; // principal of ORG
const B1 = 95802; // ACTIVE BRANCH, seated, rank 10
const B2 = 95803; // ACTIVE DISTRIBUTOR, seated, rank 20
const S = 95804; // SUSPENDED BRANCH (seated)
const U = 95805; // ACTIVE BRANCH without a seat
const XP = 95806; // principal of FOREIGN_ORG
const XB = 95807; // ACTIVE BRANCH of FOREIGN_ORG
const ORG = 95801;
const FOREIGN_ORG = 95802;

// Reference locations (tests/setup/seed_reference.sql)
const MAHARASHTRA = 116;
const PUNE = 1057;
const MUMBAI = 1056;
const NAGPUR = 1059;
const GOA = 115;
const BARDEZ = 1260;

const H_PUNE = 95821;
const H_MUMBAI = 95822;
const H_NAGPUR = 95823;
const H_GOA = 95824;
const H_NOLOC = 95825; // text says Maharashtra/Pune, but no ids (prod has 8 such)
const H_EDIT = 95826; // edited through the hospitality API

const CAT = TEST_CATEGORIES.beverages;
const OTHER_CAT = TEST_CATEGORIES.beverages + 1;
const BASE = "/api/v1/vendor-network";
const BUYER_ADMIN = IDS.users.companyA_admin;

const savedFee = process.env.NETWORK_SEAT_FEE_INR;
let priorAdminUserType;
const created = { rfqIds: [], hotelIds: [] };

beforeAll(async () => {
  await cleanupVendorNetworkFixtures();
  for (const id of [P, B1, B2, S, U, XP, XB]) {
    await seedVendorEntity({ id, companyId: id, name: `VN Cov ${id}`, email: `vn-cov-${id}@example.com` });
  }
  await seedOrg({ id: ORG, principalVendorId: P, name: "VN Coverage Org" });
  await addEntity({ orgId: ORG, vendorId: B1 });
  await addEntity({ orgId: ORG, vendorId: B2, relationship: "DISTRIBUTOR" });
  await addEntity({ orgId: ORG, vendorId: S, status: "SUSPENDED" });
  await addEntity({ orgId: ORG, vendorId: U, withSeat: false });
  await db.none(`UPDATE tbl_vendor_org_entities SET preference_rank = 10 WHERE vendor_id = $1`, [B1]);
  await db.none(`UPDATE tbl_vendor_org_entities SET preference_rank = 20 WHERE vendor_id = $1`, [B2]);
  await seedOrg({ id: FOREIGN_ORG, principalVendorId: XP, name: "VN Coverage Foreign Org" });
  await addEntity({ orgId: FOREIGN_ORG, vendorId: XB });

  await seedHotel({ id: H_PUNE, name: "VN Cov Pune", state: "Maharashtra", city: "Pune", stateId: MAHARASHTRA, cityId: PUNE });
  await seedHotel({ id: H_MUMBAI, name: "VN Cov Mumbai", state: "Maharashtra", city: "Mumbai", stateId: MAHARASHTRA, cityId: MUMBAI });
  await seedHotel({ id: H_NAGPUR, name: "VN Cov Nagpur", state: "Maharashtra", city: "Nagpur", stateId: MAHARASHTRA, cityId: NAGPUR });
  await seedHotel({ id: H_GOA, name: "VN Cov Goa", state: "Goa", city: "Bardez", stateId: GOA, cityId: BARDEZ });
  await seedHotel({ id: H_NOLOC, name: "VN Cov No Location", state: "Maharashtra", city: "Pune" });
  await seedHotel({ id: H_EDIT, name: "VN Cov Editable" });

  const row = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [BUYER_ADMIN]);
  priorAdminUserType = row.user_type;
});

afterEach(async () => {
  if (savedFee === undefined) delete process.env.NETWORK_SEAT_FEE_INR;
  else process.env.NETWORK_SEAT_FEE_INR = savedFee;
  await db.none(`DELETE FROM tbl_vendor_coverage_rules WHERE entity_vendor_id BETWEEN 95801 AND 95849`);
  if (created.rfqIds.length) {
    const ids = created.rfqIds.splice(0);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
  }
  if (created.hotelIds.length) {
    await db.none(`DELETE FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [created.hotelIds.splice(0)]);
  }
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [BUYER_ADMIN, priorAdminUserType]);
});

afterAll(async () => {
  await cleanupVendorNetworkFixtures();
  await closeDb();
});

/** Inserts coverage rules [entity, scope_type, scope_id, mode, category_id?] on `runner`. */
async function rules(runner, ...rows) {
  for (const [entity, scopeType, scopeId, mode, categoryId = null] of rows) {
    await runner.none(
      `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode, category_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entity, scopeType, scopeId, mode, categoryId]
    );
  }
}

const covers = (t, entity, hotel, category = null) => entityCoversHotel(entity, hotel, category, t);

describe("resolveHotelLocationIds", () => {
  it("matches India state and in-state city text case/trim-insensitively", async () => {
    expect(await resolveHotelLocationIds("maharashtra ", "Pune")).toEqual({ state_id: MAHARASHTRA, city_id: PUNE });
    expect(await resolveHotelLocationIds("  GOA", " bardez ")).toEqual({ state_id: GOA, city_id: BARDEZ });
  });

  it("an unknown city keeps the state; an unknown state or a city of another state resolves nothing", async () => {
    expect(await resolveHotelLocationIds("Maharashtra", "Atlantis")).toEqual({ state_id: MAHARASHTRA, city_id: null });
    expect(await resolveHotelLocationIds("Maharashtra", "Bardez")).toEqual({ state_id: MAHARASHTRA, city_id: null });
    expect(await resolveHotelLocationIds("Atlantis", "Pune")).toEqual({ state_id: null, city_id: null });
    expect(await resolveHotelLocationIds(null, null)).toEqual({ state_id: null, city_id: null });
    expect(await resolveHotelLocationIds("", "")).toEqual({ state_id: null, city_id: null });
  });

  it("parity with vn_backfill_hotel_location_ids on the same hotels, ambiguous names included", async () => {
    await withTx(async (t) => {
      // Ambiguous: a state name twice in India, a city name twice in one state; a
      // same-named state outside India must not count against the Indian one.
      await t.none(
        `INSERT INTO tbl_location_states (id, state_name, country_id) VALUES
           (95831, 'Vnet Twin State', 1), (95832, 'vnet twin state ', 1),
           (95833, 'Vnet Solo State', 1), (95834, 'Vnet Solo State', 2)`
      );
      await t.none(
        `INSERT INTO tbl_location_cities (id, city_name, state_id) VALUES
           (95835, 'Vnet Twin City', ${MAHARASHTRA}), (95836, 'VNET TWIN CITY', ${MAHARASHTRA}),
           (95837, 'Vnet Solo City', 95833), (95838, 'Vnet Twin State City', 95831)`
      );
      const cases = [
        ["Maharashtra", "Pune"],
        [" maharashtra", "PUNE "],
        ["Maharashtra", "Vnet Twin City"],
        ["Vnet Twin State", "Vnet Twin State City"],
        ["Vnet Solo State", "Vnet Solo City"],
        ["Vnet Solo State", "Pune"],
        ["Goa", "Pune"],
        ["Atlantis", null],
        [null, "Pune"],
        ["", ""],
      ];
      for (const [i, [state, city]] of cases.entries()) {
        await seedHotel({ id: 95840 + i, name: `VN Cov parity ${i}`, state, city, runner: t });
      }
      await t.one(`SELECT vn_backfill_hotel_location_ids()`);
      const stored = await t.any(
        `SELECT id, state, city, state_id, city_id FROM tbl_hospitality_company_hotels
          WHERE id BETWEEN 95840 AND 95849 ORDER BY id`
      );
      expect(stored).toHaveLength(cases.length);
      for (const h of stored) {
        expect({ id: h.id, ...(await resolveHotelLocationIds(h.state, h.city, t)) }).toEqual({
          id: h.id,
          state_id: h.state_id,
          city_id: h.city_id,
        });
      }
      const byId = Object.fromEntries(stored.map((h) => [h.id, h]));
      expect(byId[95842]).toMatchObject({ state_id: MAHARASHTRA, city_id: null }); // ambiguous city
      expect(byId[95843]).toMatchObject({ state_id: null, city_id: null }); // ambiguous state
      expect(byId[95844]).toMatchObject({ state_id: 95833, city_id: 95837 }); // non-India twin ignored
    });
  });
});

describe("hotel writes keep state_id/city_id in sync", () => {
  it("PUT /hospitality/company/:id/hotels/:hotel_id sets and re-resolves the ids", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [BUYER_ADMIN]);
    const client = await httpClient(BUYER_ADMIN);
    const url = `/api/v1/hospitality/company/${IDS.hospitality.A}/hotels/${H_EDIT}`;

    let res = await client.put(url).send({ name: "VN Cov Editable", state: "maharashtra", city: " pune" });
    expect(res.status).toBe(200);
    let row = await db.one(`SELECT state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = $1`, [H_EDIT]);
    expect(row).toEqual({ state_id: MAHARASHTRA, city_id: PUNE });

    res = await client.put(url).send({ name: "VN Cov Editable", state: "Maharashtra", city: "Atlantis" });
    expect(res.status).toBe(200);
    row = await db.one(`SELECT state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = $1`, [H_EDIT]);
    expect(row).toEqual({ state_id: MAHARASHTRA, city_id: null });

    res = await client.put(url).send({ name: "VN Cov Editable", state: "", city: "" });
    expect(res.status).toBe(200);
    row = await db.one(`SELECT state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = $1`, [H_EDIT]);
    expect(row).toEqual({ state_id: null, city_id: null });
  });

  it("POST /hospitality/company/:id/hotels stores the resolved ids", async () => {
    await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id = $1`, [BUYER_ADMIN]);
    const client = await httpClient(BUYER_ADMIN);
    const res = await client
      .post(`/api/v1/hospitality/company/${IDS.hospitality.A}/hotels`)
      .send({ name: "VN Cov Created", state: "Goa", city: "Bardez" });
    expect(res.status).toBe(200);
    created.hotelIds.push(res.body.data.id);
    const row = await db.one(`SELECT state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = $1`, [
      res.body.data.id,
    ]);
    expect(row).toEqual({ state_id: GOA, city_id: BARDEZ });
  });
});

describe("hotel_location_report", () => {
  it("findUnmatchedHotels lists hotels without ids, with the reason, and formatReport prints them", async () => {
    const rows = await findUnmatchedHotels(db);
    const ours = rows.filter((r) => r.id >= 95821 && r.id <= 95826);
    expect(ours.map((r) => [r.id, r.reason])).toEqual([
      [H_NOLOC, "STATE_UNMATCHED"],
      [H_EDIT, "NO_STATE_TEXT"],
    ]);
    const text = formatReport(ours);
    expect(text).toContain(`${H_NOLOC}\tSTATE_UNMATCHED\tstate="Maharashtra"\tcity="Pune"`);
    expect(text.split("\n")[0]).toBe("2 hotel(s) without full location ids");
  });
});

describe("coverage decision (entityCoversHotel)", () => {
  it("a state include covers every hotel in that state, and none elsewhere", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"]);
      for (const h of [H_PUNE, H_MUMBAI, H_NAGPUR]) {
        expect(await covers(t, B1, h)).toEqual({ covered: true, specificity: 1 });
      }
      expect(await covers(t, B1, H_GOA)).toEqual({ covered: false, specificity: 0 });
    });
  });

  it("a city exclude inside a state include uncovers that city only", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"], [B1, "CITY", PUNE, "EXCLUDE"]);
      expect(await covers(t, B1, H_PUNE)).toEqual({ covered: false, specificity: 2 });
      expect(await covers(t, B1, H_MUMBAI)).toEqual({ covered: true, specificity: 1 });
    });
  });

  it("a hotel include beats a city exclude", async () => {
    await withTx(async (t) => {
      await rules(
        t,
        [B1, "STATE", MAHARASHTRA, "INCLUDE"],
        [B1, "CITY", PUNE, "EXCLUDE"],
        [B1, "HOTEL", H_PUNE, "INCLUDE"]
      );
      expect(await covers(t, B1, H_PUNE)).toEqual({ covered: true, specificity: 3 });
    });
  });

  it("a category-specific exclude beats a category-NULL include at equal specificity, for that category only", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"], [B1, "STATE", MAHARASHTRA, "EXCLUDE", CAT]);
      expect(await covers(t, B1, H_PUNE, CAT)).toEqual({ covered: false, specificity: 1 });
      expect(await covers(t, B1, H_PUNE, OTHER_CAT)).toEqual({ covered: true, specificity: 1 });
      expect(await covers(t, B1, H_PUNE, null)).toEqual({ covered: true, specificity: 1 });
    });
  });

  it("a category-specific include beats a category-NULL exclude at equal specificity", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "CITY", PUNE, "EXCLUDE"], [B1, "CITY", PUNE, "INCLUDE", CAT]);
      expect(await covers(t, B1, H_PUNE, CAT)).toEqual({ covered: true, specificity: 2 });
      expect(await covers(t, B1, H_PUNE, null)).toEqual({ covered: false, specificity: 2 });
    });
  });

  it("hotel without location ids only matches HOTEL rules", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"], [B1, "CITY", PUNE, "INCLUDE"]);
      expect(await covers(t, B1, H_NOLOC)).toEqual({ covered: false, specificity: 0 });
      expect(await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_NOLOC] }, t)).toEqual([]);

      await rules(t, [B1, "HOTEL", H_NOLOC, "INCLUDE"]);
      expect(await covers(t, B1, H_NOLOC)).toEqual({ covered: true, specificity: 3 });
      const candidates = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_NOLOC] }, t);
      expect(candidates.map((c) => [c.entity_vendor_id, c.hotels_covered])).toEqual([[B1, [H_NOLOC]]]);
    });
  });
});

describe("resolveCoverageCandidates", () => {
  it("ranks full coverage first, then specificity, then lower preference_rank", async () => {
    await withTx(async (t) => {
      // B1 covers both hotels by STATE; B2 covers only Pune, but by HOTEL.
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"], [B2, "HOTEL", H_PUNE, "INCLUDE"]);
      let result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE, H_MUMBAI] }, t);
      expect(result).toEqual([
        {
          entity_vendor_id: B1, name: `VN Cov ${B1}`, specificity: 1, preference_rank: 10,
          covers_all_hotels: true, hotels_covered: [H_PUNE, H_MUMBAI],
        },
        {
          entity_vendor_id: B2, name: `VN Cov ${B2}`, specificity: 3, preference_rank: 20,
          covers_all_hotels: false, hotels_covered: [H_PUNE],
        },
      ]);

      // Both cover all at the same specificity: lower preference_rank first.
      await rules(t, [B2, "STATE", MAHARASHTRA, "INCLUDE"]);
      await t.none(`DELETE FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1 AND scope_type = 'HOTEL'`, [B2]);
      result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE, H_MUMBAI] }, t);
      expect(result.map((c) => c.entity_vendor_id)).toEqual([B1, B2]);
      await t.none(`UPDATE tbl_vendor_org_entities SET preference_rank = 5 WHERE vendor_id = $1`, [B2]);
      result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE, H_MUMBAI] }, t);
      expect(result.map((c) => c.entity_vendor_id)).toEqual([B2, B1]);

      // Specificity (max over covered hotels) breaks a full-coverage tie before rank.
      await rules(t, [B1, "CITY", PUNE, "INCLUDE"]);
      result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE, H_MUMBAI] }, t);
      expect(result.map((c) => [c.entity_vendor_id, c.specificity])).toEqual([[B1, 2], [B2, 1]]);
    });
  });

  it("applies the category decision per entity", async () => {
    await withTx(async (t) => {
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"], [B1, "STATE", MAHARASHTRA, "EXCLUDE", CAT]);
      expect(await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE], categoryId: CAT }, t)).toEqual([]);
      const other = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE], categoryId: OTHER_CAT }, t);
      expect(other.map((c) => c.entity_vendor_id)).toEqual([B1]);
    });
  });

  it("excludes SUSPENDED, unseated (when seats cost money), principal and foreign entities", async () => {
    process.env.NETWORK_SEAT_FEE_INR = "500";
    await withTx(async (t) => {
      for (const e of [P, B1, S, U, XB]) await rules(t, [e, "STATE", MAHARASHTRA, "INCLUDE"]);
      let result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE] }, t);
      expect(result.map((c) => c.entity_vendor_id)).toEqual([B1]);

      process.env.NETWORK_SEAT_FEE_INR = "0";
      result = await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE] }, t);
      expect(result.map((c) => c.entity_vendor_id).sort()).toEqual([B1, U]);
    });
  });

  it("candidate operability matches entityCanOperate (parity)", async () => {
    await withTx(async (t) => {
      const members = [B1, B2, S, U];
      for (const e of [P, ...members]) await rules(t, [e, "STATE", MAHARASHTRA, "INCLUDE"]);
      // An expired seat must not count either.
      await t.none(
        `UPDATE tbl_vendor_network_seats SET end_date = (CURRENT_DATE - 2) WHERE entity_vendor_id = $1`,
        [B2]
      );
      for (const fee of ["0", "500"]) {
        process.env.NETWORK_SEAT_FEE_INR = fee;
        const ids = (await resolveCoverageCandidates({ orgId: ORG, hotelIds: [H_PUNE] }, t)).map(
          (c) => c.entity_vendor_id
        );
        for (const e of members) {
          const { ok } = await entityCanOperate(e, t);
          expect({ fee, e, candidate: ids.includes(e) }).toEqual({ fee, e, candidate: ok });
        }
        expect(ids).not.toContain(P);
      }
    });
  });

  it("returns nothing for no hotels or an empty org", async () => {
    expect(await resolveCoverageCandidates({ orgId: ORG, hotelIds: [] })).toEqual([]);
    expect(await resolveCoverageCandidates({ orgId: null, hotelIds: [H_PUNE] })).toEqual([]);
  });
});

describe("coverage preview set", () => {
  it("is limited to hotels of the principal's RFQs and ARCs", async () => {
    await withTx(async (t) => {
      const rfq = await makeRFQ(t, { createdBy: IDS.users.a1_proc_buyer, hotel: H_PUNE, title: "VN cov preview" });
      const variant = await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
      await t.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 1)`,
        [rfq.rfq_id, variant.id, P]
      );
      await t.none(
        `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
        [rfq.rfq_id, H_GOA, IDS.users.a1_proc_buyer]
      );
      await rules(t, [B1, "STATE", MAHARASHTRA, "INCLUDE"]);

      const preview = await previewCoveredHotels({ principalVendorId: P, entityVendorId: B1 }, t);
      expect(preview.truncated).toBe(false);
      expect(preview.hotels_considered).toBe(2); // Pune (lead) + Goa (mapping); Mumbai never quoted
      expect(preview.covered.map((h) => [h.id, h.specificity])).toEqual([[H_PUNE, 1]]);

      const found = await searchPreviewHotels({ principalVendorId: P, q: "vn cov" }, t);
      expect(found.map((h) => h.id).sort()).toEqual([H_PUNE, H_GOA].sort());
      expect(await searchPreviewHotels({ principalVendorId: XP, q: "" }, t)).toEqual([]);
    });
  });
});

describe("/coverage routes", () => {
  it("PUT replaces all rules; GET returns them", async () => {
    const client = await httpClient(P);
    let res = await client.put(`${BASE}/coverage/${B1}`).send({
      rules: [
        { scope_type: "STATE", scope_id: MAHARASHTRA, mode: "INCLUDE", category_id: null },
        { scope_type: "CITY", scope_id: PUNE, mode: "EXCLUDE" },
        { scope_type: "HOTEL", scope_id: H_PUNE, mode: "INCLUDE", category_id: CAT },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rules).toHaveLength(3);
    let stored = await db.any(
      `SELECT scope_type, scope_id, mode, category_id, created_by FROM tbl_vendor_coverage_rules
        WHERE entity_vendor_id = $1 ORDER BY scope_type`,
      [B1]
    );
    expect(stored).toEqual([
      { scope_type: "CITY", scope_id: PUNE, mode: "EXCLUDE", category_id: null, created_by: P },
      { scope_type: "HOTEL", scope_id: H_PUNE, mode: "INCLUDE", category_id: CAT, created_by: P },
      { scope_type: "STATE", scope_id: MAHARASHTRA, mode: "INCLUDE", category_id: null, created_by: P },
    ]);

    res = await client.put(`${BASE}/coverage/${B1}`).send({
      rules: [{ scope_type: "STATE", scope_id: GOA, mode: "INCLUDE" }],
    });
    expect(res.status).toBe(200);
    stored = await db.any(`SELECT scope_type, scope_id FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [B1]);
    expect(stored).toEqual([{ scope_type: "STATE", scope_id: GOA }]);

    res = await client.get(`${BASE}/coverage/${B1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rules).toEqual([
      expect.objectContaining({ scope_type: "STATE", scope_id: GOA, mode: "INCLUDE", scope_name: "Goa" }),
    ]);
    expect(res.body.data.preview).toEqual({ hotels_considered: 0, truncated: false, covered: [] });

    res = await client.put(`${BASE}/coverage/${B1}`).send({ rules: [] });
    expect(res.status).toBe(200);
    expect(await db.any(`SELECT 1 FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [B1])).toEqual([]);
  });

  it("PUT refuses unknown scope ids and categories with 400 and writes nothing", async () => {
    const client = await httpClient(P);
    await client.put(`${BASE}/coverage/${B1}`).send({ rules: [{ scope_type: "STATE", scope_id: GOA, mode: "INCLUDE" }] });
    const bad = [
      { scope_type: "STATE", scope_id: PUNE, mode: "INCLUDE" }, // a city id is not a state
      { scope_type: "CITY", scope_id: 99999901, mode: "INCLUDE" },
      { scope_type: "HOTEL", scope_id: 99999902, mode: "INCLUDE" },
      { scope_type: "STATE", scope_id: MAHARASHTRA, mode: "INCLUDE", category_id: 99999903 },
    ];
    for (const rule of bad) {
      const res = await client.put(`${BASE}/coverage/${B1}`).send({
        rules: [{ scope_type: "STATE", scope_id: MAHARASHTRA, mode: "INCLUDE" }, rule],
      });
      expect({ rule, status: res.status }).toEqual({ rule, status: 400 });
      expect(res.body.status).toBe(0);
    }
    const stored = await db.any(`SELECT scope_id FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [B1]);
    expect(stored).toEqual([{ scope_id: GOA }]);
  });

  it("PUT refuses malformed, duplicate and oversized rule lists with 400", async () => {
    const client = await httpClient(P);
    const ok = { scope_type: "STATE", scope_id: MAHARASHTRA, mode: "INCLUDE" };
    for (const body of [
      {},
      { rules: "all" },
      { rules: [{ ...ok, scope_type: "COUNTRY" }] },
      { rules: [{ ...ok, mode: "MAYBE" }] },
      { rules: [{ ...ok, scope_id: "1e3" }] },
      { rules: [{ ...ok, category_id: -1 }] },
      { rules: [ok, { ...ok, mode: "EXCLUDE" }] },
      { rules: Array.from({ length: 501 }, (_, i) => ({ scope_type: "HOTEL", scope_id: i + 1, mode: "INCLUDE" })) },
    ]) {
      const res = await client.put(`${BASE}/coverage/${B1}`).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("a foreign or unknown entity is 404; the principal's own org entities only", async () => {
    const client = await httpClient(P);
    for (const target of [XB, XP, 99999904, "abc"]) {
      const put = await client.put(`${BASE}/coverage/${target}`).send({ rules: [] });
      expect({ target, status: put.status }).toEqual({ target, status: 404 });
      const get = await client.get(`${BASE}/coverage/${target}`);
      expect({ target, status: get.status }).toEqual({ target, status: 404 });
    }
  });

  it("non-admins get 403 on every coverage route", async () => {
    const client = await httpClient(B1); // an entity acting as itself is ENTITY_MEMBER
    const lone = await httpClient(IDS.users.vendor_alpha); // a vendor in no network
    for (const c of [client, lone]) {
      expect((await c.put(`${BASE}/coverage/${B1}`).send({ rules: [] })).status).toBe(403);
      expect((await c.get(`${BASE}/coverage/${B1}`)).status).toBe(403);
      expect((await c.get(`${BASE}/coverage/lookup/states`)).status).toBe(403);
      expect((await c.get(`${BASE}/coverage/lookup/cities?state_id=${MAHARASHTRA}`)).status).toBe(403);
      expect((await c.get(`${BASE}/coverage/lookup/hotels?q=a`)).status).toBe(403);
    }
  });

  it("lookups: India states, cities of one state, preview-set hotels by name", async () => {
    const client = await httpClient(P);
    let res = await client.get(`${BASE}/coverage/lookup/states`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([{ id: MAHARASHTRA, name: "Maharashtra" }]));

    res = await client.get(`${BASE}/coverage/lookup/cities`);
    expect(res.status).toBe(400);
    res = await client.get(`${BASE}/coverage/lookup/cities?state_id=${MAHARASHTRA}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([{ id: PUNE, name: "Pune" }]));
    expect(res.body.data.map((c) => c.id)).not.toContain(BARDEZ);

    // Preview set: the principal quoted an RFQ at the Pune hotel only.
    const rfq = await makeRFQ(db, { createdBy: IDS.users.a1_proc_buyer, hotel: H_PUNE, title: "VN cov lookup" });
    created.rfqIds.push(rfq.rfq_id);
    const variant = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 1)`,
      [rfq.rfq_id, variant.id, P]
    );
    res = await client.get(`${BASE}/coverage/lookup/hotels?q=VN%20Cov`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((h) => h.id)).toEqual([H_PUNE]);
    res = await client.get(`${BASE}/coverage/lookup/hotels?q=%25`);
    expect(res.body.data).toEqual([]); // % is literal, not a wildcard

    // The GET preview now evaluates that hotel.
    await client.put(`${BASE}/coverage/${B1}`).send({ rules: [{ scope_type: "CITY", scope_id: PUNE, mode: "INCLUDE" }] });
    res = await client.get(`${BASE}/coverage/${B1}`);
    expect(res.body.data.preview).toEqual({
      hotels_considered: 1,
      truncated: false,
      covered: [{ id: H_PUNE, name: "VN Cov Pune", city: "Pune", state: "Maharashtra", specificity: 2 }],
    });
  });
});
