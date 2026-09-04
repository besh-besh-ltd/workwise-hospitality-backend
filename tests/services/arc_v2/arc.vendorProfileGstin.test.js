// ARC v2 — the vendor quote form seeds its GSTIN box from the company profile.
//
// Same defect as the RFQ quote wizard, same shape: `gstin_used` is a column on
// tbl_arc_quote, so it is scoped to ONE contract quote and every new ARC opened
// with an empty box. Vendors read that as "the GSTIN I entered was lost".
//
// The detail payload now carries `vendor_profile_gstin` alongside the quote, so
// the client can SEED an empty box without ever overriding a `gstin_used` the
// vendor actually submitted for this contract.
//
//   npm test -- arc.vendorProfileGstin

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VENDOR_COMPANY = IDS.companies.vendorAlpha;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = "/api/v1/arc-v2/vendor";
const PROFILE_GSTIN = "29AAACW1234F1Z5";
const QUOTE_GSTIN = "27BBBCW9876K1Z3";

const createdArcIds = [];
let client;
let originalCompanyGstin;

async function seedFloatedArc(number) {
  const arc = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id,
        department_id, process_id, status,
        submission_start_at, submission_end_at,
        contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'GSTIN seed', $2, $3, $4, $5, $6, 'floated',
             NOW() - INTERVAL '2 days', NOW() + INTERVAL '10 days',
             NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $7)
     RETURNING id`,
    [number, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
  );
  createdArcIds.push(Number(arc.id));

  await db.none(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
     VALUES ($1, $2, 500, 'litre', 100)`,
    [arc.id, VARIANT_ID]
  );
  await db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
     VALUES ($1, $2, 'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
    [Number(arc.id), VENDOR]
  );
  return Number(arc.id);
}

const detail = async (arcId) => {
  const res = await client.get(`${VENDOR_BASE}/requests/${arcId}`);
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
  originalCompanyGstin = (
    await db.one(`SELECT gstin FROM tbl_company WHERE id = $1`, [VENDOR_COMPANY])
  ).gstin;
  client = await httpClient(VENDOR);
});

afterAll(async () => {
  if (createdArcIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`,
      [createdArcIds.map(String)]
    );
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
  }
  await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
    VENDOR_COMPANY,
    originalCompanyGstin,
  ]);
});

describe("ARC vendor request detail — company-profile GSTIN", () => {
  it("carries the vendor's profile GSTIN so a first quote can seed the field", async () => {
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
      VENDOR_COMPANY,
      PROFILE_GSTIN,
    ]);
    const arcId = await seedFloatedArc(`ARC-GST-${Date.now()}-1`);

    const data = await detail(arcId);

    expect(data.vendor_profile_gstin).toBe(PROFILE_GSTIN);
  });

  it("returns null when the vendor's profile carries no GSTIN", async () => {
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [VENDOR_COMPANY]);
    const arcId = await seedFloatedArc(`ARC-GST-${Date.now()}-2`);

    const data = await detail(arcId);

    expect(data.vendor_profile_gstin).toBeNull();
  });

  it("reports the quote's own gstin_used separately, so the profile never overrides it", async () => {
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
      VENDOR_COMPANY,
      PROFILE_GSTIN,
    ]);
    const arcId = await seedFloatedArc(`ARC-GST-${Date.now()}-3`);
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, gstin_used) VALUES ($1, $2, $3)`,
      [arcId, VENDOR, QUOTE_GSTIN]
    );

    const data = await detail(arcId);

    expect(data.quote.gstin_used).toBe(QUOTE_GSTIN);
    expect(data.vendor_profile_gstin).toBe(PROFILE_GSTIN);
  });
});
