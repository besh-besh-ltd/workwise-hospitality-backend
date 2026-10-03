/**
 * POST /rfq/add-products-to-draft — equivalence + query budget.
 *
 * p95 11-24 s on prod. Per variant the handler issued one INSERT INTO
 * tbl_rfq_product_vendors PER ELIGIBLE VENDOR, serially (hundreds of round
 * trips for a popular category), after resolving eligible vendors one unique
 * variant at a time. The vendor mapping is now one multi-row INSERT per
 * variant and the eligibility lookups are issued together up front.
 *
 * Pinned: the response and the rows written (products + vendor mappings, in
 * id order) are snapshotted against the pre-change code; the statement count
 * must not scale with the number of vendors.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { normalizeForSnapshot } from "../helpers/perfRichRfq.js";

const BUYER = IDS.users.a1_proc_buyer;
// alpha (active) + gamma (expired, still invited) hold a BEVERAGES category
// subscription in the fixtures; beta holds beverages + juice.
const VENDORS = [IDS.users.vendor_alpha, IDS.users.vendor_beta, IDS.users.vendor_gamma];

// Whole request, auth included, 3 variants (one repeated) x 3 vendors.
//   before: 27 statements / 27 waves, 9 vendor INSERTs (one per vendor)
const BUDGET = { statements: 27, waves: 27, vendorInserts: 9 };

describe("POST /rfq/add-products-to-draft — equivalence + query budget", () => {
  let client;
  let variants;
  const made = { mappingIds: [], subIds: [], rfqIds: [] };

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    variants = (await db.any(
      `SELECT pv.id FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pc.category_id = 215 ORDER BY pv.id LIMIT 2`
    )).map((r) => r.id);
    expect(variants).toHaveLength(2);
    for (const v of variants) {
      for (const vendor of VENDORS) {
        const r = await db.one(
          `INSERT INTO tbl_product_variant_vendor_mapping
             (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
           VALUES ($1, $2, true, true, $2, now(), now()) RETURNING id`, [v, vendor]);
        made.mappingIds.push(r.id);
      }
    }
    for (const vendor of VENDORS) {
      const r = await db.oneOrNone(
        `INSERT INTO tbl_vendor_hotel_category_subscription
           (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
         VALUES ($1, 'hotel', $2, 500, (now() - interval '30 days')::date, (now() + interval '300 days')::date, 'active')
         ON CONFLICT ON CONSTRAINT uq_vendor_hotel_category_subscription DO NOTHING RETURNING id`,
        [vendor, IDS.hotels.A1]);
      if (r) made.subIds.push(r.id);
    }
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    if (made.rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [made.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [made.rfqIds]);
    }
    if (made.mappingIds.length) await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [made.mappingIds]);
    if (made.subIds.length) await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [made.subIds]);
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  });

  const addProducts = () => client.post(`/api/v1/rfq/add-products-to-draft`).send({
    hotel_ids: [IDS.hotels.A1],
    variants: [{ variant_id: variants[0] }, { variant_id: variants[1] }, { variant_id: variants[0] }, {}],
  });

  const writtenRows = async (rfqId) => ({
    products: await db.any(
      `SELECT product_variant_id, variant, comment, datasheet, spec_file, qap_file, qap, datasheet_file, sheet_id
         FROM tbl_rfq_products WHERE rfq_id = $1 ORDER BY id`, [rfqId]),
    vendors: await db.any(
      `SELECT product_variant_id, user_id, variant, sheet_id, is_rfq_viewed, vendor_name
         FROM tbl_rfq_product_vendors WHERE rfq_id = $1 ORDER BY id`, [rfqId]),
  });

  it("writes the same rows and returns the same body as before", async () => {
    const res = await addProducts();
    expect(res.status).toBe(200);
    made.rfqIds.push(res.body.data.rfq_id);
    const rows = await writtenRows(res.body.data.rfq_id);
    expect(rows.vendors.length).toBe(9);
    expect(normalizeForSnapshot({ body: res.body, rows })).toMatchSnapshot();
  });

  it("does not issue a statement per vendor", async () => {
    const { result: res, count, waves, statements } = await countQueries(addProducts);
    made.rfqIds.push(res.body.data.rfq_id);
    if (process.env.PERF_DUMP) console.log(`[add-to-draft] ${count} statements, waves ${waves}\n${statements.map((s) => s.slice(0, 110)).join("\n")}`);
    expect(count).toBeLessThanOrEqual(BUDGET.statements);
    expect(waves).toBeLessThanOrEqual(BUDGET.waves);
    const vendorInserts = statements.filter((s) => /INSERT INTO "?tbl_rfq_product_vendors"?/i.test(s));
    expect(vendorInserts.length).toBeLessThanOrEqual(BUDGET.vendorInserts);
  });
});
