// Vendor GSTIN is a per-QUOTE column (tbl_quotes.gstin), not a vendor
// attribute. Every new RFQ therefore presented an empty GSTIN box, even though
// the platform already holds that vendor's GSTIN on their company profile
// (422 of 475 production vendors have one). Vendors read the blank box as
// "the GSTIN I entered was lost" and could not tell whether they had ever
// supplied it.
//
// The PO builder already resolves this the right way —
// purchaseOrderModel.js: `'gstin', COALESCE(TQ.gstin, TCSUP.gstin)` — so the
// company profile is already the established fallback. The quote form was the
// only surface that ignored it.
//
// The contract locked in here: the vendor-facing RFQ detail payload carries
// `vendor_profile_gstin`, so the quote wizard can SEED an empty GSTIN box from
// the vendor's own profile. It is a seed, never an override: a quote that
// already carries its own GSTIN keeps it (delivery-location GSTINs legitimately
// differ from the head-office one), which is why the two fields travel
// separately instead of being COALESCEd in SQL.
//
//   npm test -- rfq.vendorProfileGstin

import {
  describe, it, expect, beforeAll, afterAll, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VENDOR_COMPANY = IDS.companies.vendorAlpha;
const VARIANT_ID = 1;

const PROFILE_GSTIN = "29AAACW1234F1Z5";
const QUOTE_GSTIN = "27BBBCW9876K1Z3";

let client;
let originalCompanyGstin;

beforeAll(async () => {
  // Fixture users carry user_type = NULL; the vendor branch of getRfqById is
  // gated on user_type = 3.
  await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
  originalCompanyGstin = (
    await db.one(`SELECT gstin FROM tbl_company WHERE id = $1`, [VENDOR_COMPANY])
  ).gstin;
  client = await httpClient(VENDOR);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [VENDOR]);
  await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
    VENDOR_COMPANY,
    originalCompanyGstin,
  ]);
  await closeDb();
});

const inserted = { rfqIds: [] };

afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
    inserted.rfqIds = [];
  }
  await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
    VENDOR_COMPANY,
    originalCompanyGstin,
  ]);
});

/** A published RFQ with one product the fixture vendor is invited to quote on. */
async function seedInvitedRfq() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    title: "GSTIN seed",
  });
  inserted.rfqIds.push(Number(rfq_id));

  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)`,
    [rfq_id, VARIANT_ID]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, VENDOR]
  );
  return Number(rfq_id);
}

/** The vendor's submitted quote for `rfqId`, optionally carrying its own GSTIN. */
async function seedQuote(rfqId, gstin) {
  const rfq = await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [rfqId]);
  await db.none(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, gstin)
     VALUES ($1, $2, 1, $3, $3, $4)`,
    [rfqId, rfq.rfq_no, VENDOR, gstin]
  );
}

const detail = async (rfqId) => {
  const res = await client.get(`/api/v1/rfq/getRfqById/${rfqId}`);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe("vendor RFQ detail — company-profile GSTIN", () => {
  it("carries the vendor's profile GSTIN so a first quote can seed the field", async () => {
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
      VENDOR_COMPANY,
      PROFILE_GSTIN,
    ]);
    const rfqId = await seedInvitedRfq();

    const data = await detail(rfqId);

    expect(data.vendor_profile_gstin).toBe(PROFILE_GSTIN);
  });

  it("returns null when the vendor's profile carries no GSTIN", async () => {
    await db.none(`UPDATE tbl_company SET gstin = NULL WHERE id = $1`, [VENDOR_COMPANY]);
    const rfqId = await seedInvitedRfq();

    const data = await detail(rfqId);

    expect(data.vendor_profile_gstin).toBeNull();
  });

  it("treats a blank profile GSTIN as absent rather than seeding an empty string", async () => {
    await db.none(`UPDATE tbl_company SET gstin = '   ' WHERE id = $1`, [VENDOR_COMPANY]);
    const rfqId = await seedInvitedRfq();

    const data = await detail(rfqId);

    expect(data.vendor_profile_gstin).toBeNull();
  });

  it("still reports the quote's own GSTIN separately, so the profile never overrides it", async () => {
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
      VENDOR_COMPANY,
      PROFILE_GSTIN,
    ]);
    const rfqId = await seedInvitedRfq();
    await seedQuote(rfqId, QUOTE_GSTIN);

    const data = await detail(rfqId);

    // Both travel; the client decides. The quote's own value is what the vendor
    // actually submitted and must survive a reload untouched.
    expect(data.quote_details.gstin).toBe(QUOTE_GSTIN);
    expect(data.vendor_profile_gstin).toBe(PROFILE_GSTIN);
  });

  it("offers the profile GSTIN on a quote that was submitted without one", async () => {
    await db.none(`UPDATE tbl_company SET gstin = $2 WHERE id = $1`, [
      VENDOR_COMPANY,
      PROFILE_GSTIN,
    ]);
    const rfqId = await seedInvitedRfq();
    await seedQuote(rfqId, null);

    const data = await detail(rfqId);

    // 566 of 967 production quotes are in exactly this state.
    expect(data.quote_details.gstin).toBeNull();
    expect(data.vendor_profile_gstin).toBe(PROFILE_GSTIN);
  });
});
