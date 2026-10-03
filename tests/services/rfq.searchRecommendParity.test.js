// Product search + Start-RFQ recommendations: the perf rewrites return exactly
// what the old queries returned (portal perf plan 2026-10, items 1.1/1.4/1.5).
//
//   searchProduct
//     - candidate stage now UNIONs one indexable predicate per branch (slug,
//       FTS, `%` trigram under SET LOCAL threshold 0.1) instead of ORing
//       similarity() > 0.1 across two tables, which no index can serve;
//     - the vendor-count CTE semi-joins the hotel subscription instead of
//       joining it (a vendor subscribed to N hotels multiplied its rows N x).
//   getRecommendedProducts
//     - candidate_variants is folded into the vendor_counts aggregate instead
//       of a second DISTINCT pass over the mapping table.
//
// Both now carry a deterministic final tie-break the old queries lacked, so
// the oracle (tests/helpers/legacy/*, frozen copies of origin/main) can only be
// compared modulo the order of rows whose ORIGINAL sort keys tie: we require
// the same rows, and the same sequence of original sort keys.
//
// The data is the committed perf world (tests/helpers/perfParityWorld.js) over
// the ~13k real reference variants, with vendor mappings that include
// duplicates, unapproved rows, and multi-hotel subscription fan-out.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { seedPerfWorld } from "../helpers/perfParityWorld.js";
import rfqModel from "../../app/models/rfqModel.js";
import appDb from "../../app/config/dbConn.js";
import { searchProductLegacy } from "../helpers/legacy/searchProductLegacy.js";
import { getRecommendedProductsLegacy } from "../helpers/legacy/recommendedProductsLegacy.js";

let world;

beforeAll(async () => {
  const t0 = Date.now();
  world = await seedPerfWorld(db);
  console.log(`[perf-world] seeded in ${Date.now() - t0} ms`);
}, 120000);

afterAll(async () => {
  if (world) await world.cleanup();
  await closeDb();
});

const canon = (rows) => rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();

function expectSameModuloTies(actual, expected, keyOf) {
  expect(actual.length).toBe(expected.length);
  expect(actual.map(keyOf)).toEqual(expected.map(keyOf));
  expect(canon(actual)).toEqual(canon(expected));
}

describe("searchProduct — rewritten candidate stage is result-identical", () => {
  let exactSlug;
  let exactName;

  beforeAll(async () => {
    const row = await db.one(
      `SELECT pv.slug, pv.name FROM tbl_product_variant pv
         JOIN tbl_product p ON p.id = pv.product_id
        WHERE pv.is_approve = 1 AND p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1
        ORDER BY pv.id LIMIT 1 OFFSET 3`
    );
    exactSlug = row.slug;
    exactName = row.name;
  });

  const TERMS = () => [
    "coke", "COKE COCA COLA 2 LTR", exactSlug, exactName, "pepsi 600", "coca", "kola", "pepsee",
    "7 up", "juice", "the", "zzzzqx", "a", "  coke  ", "all", "ALL",
  ];
  const ARG_SETS = [
    { label: "no filters", category: "", approved: "", hotels: [] },
    { label: "hotels A1+A2 (vendor counts)", category: "", approved: "", hotels: [IDS.hotels.A1, IDS.hotels.A2] },
    { label: "hotel B1", category: "", approved: "", hotels: [IDS.hotels.B1] },
    { label: "all hotels", category: "", approved: "", hotels: [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2] },
    { label: "category 215", category: 215, approved: "", hotels: [] },
    { label: "category 215 + hotels", category: 215, approved: "", hotels: [IDS.hotels.A1, IDS.hotels.A3] },
    { label: "approved_by 1", category: "", approved: 1, hotels: [IDS.hotels.A1] },
  ];

  const searchKey = (term) => (r) => JSON.stringify([
    r.slug === (term || "").trim() ? 0 : 1, Number(r.rank), Number(r.similarity_score), r.unified_name,
  ]);

  it("matches the frozen oracle for every term x filter combination", async () => {
    let compared = 0;
    let nonEmpty = 0;
    for (const term of TERMS()) {
      for (const a of ARG_SETS) {
        const [actual, expected] = await Promise.all([
          rfqModel.searchProduct(term, a.category, a.approved, {}, a.hotels),
          searchProductLegacy(term, a.category, a.approved, {}, a.hotels),
        ]);
        try {
          expectSameModuloTies(actual, expected, searchKey(term));
        } catch (e) {
          e.message = `term=${JSON.stringify(term)} args=${a.label}\n${e.message}`;
          throw e;
        }
        compared++;
        if (expected.length) nonEmpty++;
      }
    }
    expect(compared).toBe(TERMS().length * ARG_SETS.length);
    // the comparison must actually exercise rows, not just agree on emptiness
    expect(nonEmpty).toBeGreaterThan(compared / 2);
  }, 120000);

  it("hotel-scoped vendor counts are non-trivial (the semi-join is exercised)", async () => {
    const rows = await rfqModel.searchProduct("all", "", "", {}, [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2]);
    expect(rows.some((r) => r.vendor_count > 1)).toBe(true);
  });

  it("is deterministic: repeated calls return the same order", async () => {
    const a = await rfqModel.searchProduct("coke", "", "", {}, [IDS.hotels.A1]);
    const b = await rfqModel.searchProduct("coke", "", "", {}, [IDS.hotels.A1]);
    expect(b).toEqual(a);
  });

  it("the similarity threshold is transaction-local and never leaks onto pooled connections", async () => {
    await rfqModel.searchProduct("coke", "", "", {}, []);
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => appDb.one(`SELECT current_setting('pg_trgm.similarity_threshold', true) AS v`))
    );
    // unset (extension GUC not yet loaded on that backend) or the 0.3 default
    for (const r of rows) expect(r.v === null || r.v === '' || Number(r.v) === 0.3).toBe(true);
  });

  it("POST /rfq/search-product still answers through the full route", async () => {
    const client = await httpClient(null);
    const res = await client.post("/api/v1/rfq/search-product").send({ search_key: "coke", hotel_ids: [IDS.hotels.A1] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe("getRecommendedProducts — single aggregate is result-identical", () => {
  const recKey = (r) => JSON.stringify([Number(r.score), r.product_name]);
  const CASES = () => {
    const U = world.users;
    const allHotels = [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2];
    return [
      { user_id: U.wide, hotel_ids: allHotels, staged_variant_ids: [] },
      { user_id: U.wide, hotel_ids: [IDS.hotels.A1], staged_variant_ids: [] },
      { user_id: U.hotel, hotel_ids: [IDS.hotels.A1, IDS.hotels.A2], staged_variant_ids: [1, 2, 3] },
      { user_id: U.process, hotel_ids: [IDS.hotels.A3], staged_variant_ids: [5] },
      { user_id: U.hotelB, hotel_ids: [IDS.hotels.B1], staged_variant_ids: [] },
      { user_id: IDS.users.a1_proc_buyer, hotel_ids: allHotels, staged_variant_ids: [10, 11] },
    ];
  };

  it("full ranking matches the oracle (same rows, same original sort-key sequence)", async () => {
    let nonEmpty = 0;
    for (const c of CASES()) {
      const args = { ...c, limit: 100000 };
      const [actual, expected] = await Promise.all([
        rfqModel.getRecommendedProducts(args),
        getRecommendedProductsLegacy(args),
      ]);
      // the old ORDER BY was (score, user_history_score, popularity_score,
      // product_name); the two score parts are not projected, but score and
      // product_name are, and a reorder of distinct keys would show here.
      expectSameModuloTies(actual, expected, recKey);
      if (expected.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(3);
  });

  it("top-N under a LIMIT is a prefix-equivalent of the oracle's ranking", async () => {
    for (const c of CASES()) {
      for (const limit of [4, 20]) {
        const [actual, full] = await Promise.all([
          rfqModel.getRecommendedProducts({ ...c, limit }),
          getRecommendedProductsLegacy({ ...c, limit: 100000 }),
        ]);
        expect(actual.length).toBe(Math.min(limit, full.length));
        expect(actual.map(recKey)).toEqual(full.slice(0, actual.length).map(recKey));
        const fullSet = new Set(canon(full));
        for (const row of canon(actual)) expect(fullSet.has(row)).toBe(true);
      }
    }
  });

  it("staged variants are excluded and vendor counts are distinct vendors", async () => {
    const staged = [1, 2, 3];
    const rows = await rfqModel.getRecommendedProducts({
      user_id: world.users.wide,
      hotel_ids: [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2],
      staged_variant_ids: staged,
      limit: 100000,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(staged).not.toContain(r.variant_id);
    for (const r of rows.slice(0, 10)) {
      const { n } = await db.one(
        `SELECT COUNT(DISTINCT m.vendor_id)::int AS n
           FROM tbl_product_variant_vendor_mapping m
          WHERE m.product_variant_id = $1 AND m.status AND m.is_approved
            AND m.vendor_id IN (SELECT vendor_id FROM tbl_vendor_hotel_category_subscription
                                 WHERE item_type = 'hotel' AND item_id = ANY($2) AND status IN ('active','expired'))`,
        [r.variant_id, [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3, IDS.hotels.B1, IDS.hotels.B2]]
      );
      expect(r.vendor_count).toBe(n);
    }
  });

  it("POST /rfq/recommended-products returns the model's ranking", async () => {
    const client = await httpClient(world.users.wide);
    const body = { hotel_ids: [IDS.hotels.A1, IDS.hotels.A2], variant_ids: [1], limit: 6 };
    const res = await client.post("/api/v1/rfq/recommended-products").send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const direct = await rfqModel.getRecommendedProducts({
      user_id: world.users.wide, hotel_ids: body.hotel_ids, staged_variant_ids: [1], limit: 6,
    });
    expect(res.body.data).toEqual(JSON.parse(JSON.stringify(direct)));
  });
});
