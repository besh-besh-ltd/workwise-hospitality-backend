// Duplicate company grants must not break the draft save (RFQ 1527, Oct 2026).
// ---------------------------------------------------------------------------
// Production: a buyer had been granted access to his hospitality company three
// times (three identical company-level rows in tbl_hospitality_user_mappings —
// the unique key let them in because their hotel column is NULL, and Postgres
// treats NULLs as distinct). He held no hotel-level row for the business unit
// he picked, so the access check fell back to the company-level lookup, which
// read a single row with oneOrNone. Three rows came back, pg-promise threw
// "Multiple rows were not expected.", and every save of the create-RFQ wizard
// after choosing the business unit answered 500. The same lookup guards the
// Negotiations listing when that company is the selected context (400 there).
//
// The contract these tests lock in:
//   - a buyer whose company grant is duplicated can save the draft
//   - the Negotiations listing loads with that company selected
//   - the check is not weakened: no grant -> refused; a hotel-level grant
//     opens that business unit only, never its siblings
//
// Pattern B (commit + cleanup) — saveRfqDraft opens its own db.tx.
//   npm test -- --testPathPatterns "rfq.draftDuplicateMapping"

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import {
  dropUserMappingUnique,
  restoreUserMappingUnique,
} from "../helpers/userMappingConstraint.js";

// Replays the production state: two company-level grants for Company A and no
// hotel-level grant.
const BUYER = IDS.users.a1_proc_buyer;
// Mapped to Company B only — no grant of any kind in Company A.
const OUTSIDER = IDS.users.companyB_admin;
// Hotel-level grant for A1 only.
const ENG_BUYER = IDS.users.a1_eng_buyer;

const USERS = [BUYER, OUTSIDER, ENG_BUYER];

let uniqueDef;
let savedMappings;
let savedUserTypes;
let buyer;

beforeAll(async () => {
  savedUserTypes = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
    [USERS]
  );
  // acl([2, 8]) on /save-draft and /negotiation/rfqs needs 2 (Buyer).
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [USERS]);

  uniqueDef = await dropUserMappingUnique();
  savedMappings = await db.any(
    `SELECT * FROM tbl_hospitality_user_mappings WHERE user_id = $1`,
    [BUYER]
  );
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [BUYER]);
  for (let i = 0; i < 2; i += 1) {
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings
         (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, auto_map_projects, created_by)
       VALUES ($1, $2, NULL, 0, true, $3)`,
      [BUYER, IDS.hospitality.A, IDS.users.superAdmin]
    );
  }

  buyer = await httpClient(BUYER);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [BUYER]);
  for (const m of savedMappings || []) {
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings
         (id, user_id, hospitality_company_id, hospitality_hotel_id, mapping_type,
          auto_map_projects, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [m.id, m.user_id, m.hospitality_company_id, m.hospitality_hotel_id, m.mapping_type,
        m.auto_map_projects, m.created_by, m.created_at]
    );
  }
  await restoreUserMappingUnique(uniqueDef);
  for (const u of savedUserTypes || []) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
  await closeDb();
});

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const ids = inserted.rfqIds;
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_filters WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_terms_map WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_files WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
});

// --- helpers ----------------------------------------------------------------

async function makeDraft(createdBy, { hotel = IDS.hotels.A1, department = IDS.departments.proc } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy,
    status: 0,
    is_published: 0,
    hospitality: IDS.hospitality.A,
    hotel,
    department,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [rfq_id, hotel, createdBy]
  );
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  return rfq_id;
}

// The wizard's auto-save sends the business unit it has selected and leaves
// the company out; the server derives the company and checks access to it.
function saveBody(rfq_id, hotel_id, comment) {
  return { rfq_id, hotel_id, comment, filters: { global: null, local: null } };
}

// ===========================================================================

describe("POST /rfq/save-draft — company access granted more than once", () => {
  it("saves the draft when the buyer's company grant is duplicated", async () => {
    const rfq_id = await makeDraft(BUYER);

    const res = await buyer
      .post("/api/v1/rfq/save-draft")
      .send(saveBody(rfq_id, IDS.hotels.A1, "terms step saved"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const after = await db.one(
      `SELECT hospitality_company_id, hotel_id, comment FROM tbl_rfq WHERE id = $1`,
      [rfq_id]
    );
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(after.hotel_id).toBe(IDS.hotels.A1);
    expect(after.comment).toBe("terms step saved");
  });
});

describe("GET /negotiation/rfqs — company access granted more than once", () => {
  it("loads the listing with that company selected", async () => {
    const res = await buyer
      .get("/api/v1/negotiation/rfqs")
      .set("x-hospitality-company", String(IDS.hospitality.A));
    expect(res.status).toBe(200);
  });
});

describe("POST /rfq/save-draft — the access check is not weakened", () => {
  it("refuses a buyer with no grant in the company", async () => {
    const rfq_id = await makeDraft(OUTSIDER);
    const outsider = await httpClient(OUTSIDER);

    const res = await outsider
      .post("/api/v1/rfq/save-draft")
      .send(saveBody(rfq_id, IDS.hotels.A1, "should not save"));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You do not have access to the selected hospitality company or hotel");

    const after = await db.one(`SELECT comment FROM tbl_rfq WHERE id = $1`, [rfq_id]);
    expect(after.comment).not.toBe("should not save");
  });

  it("a hotel-level grant opens that business unit and not its siblings", async () => {
    const eng = await httpClient(ENG_BUYER);

    const sibling = await makeDraft(ENG_BUYER, { hotel: IDS.hotels.A2, department: IDS.departments.eng });
    const refused = await eng
      .post("/api/v1/rfq/save-draft")
      .send(saveBody(sibling, IDS.hotels.A2, "should not save"));
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("You do not have access to the selected hospitality company or hotel");

    const own = await makeDraft(ENG_BUYER, { hotel: IDS.hotels.A1, department: IDS.departments.eng });
    const allowed = await eng
      .post("/api/v1/rfq/save-draft")
      .send(saveBody(own, IDS.hotels.A1, "own unit saved"));
    expect(allowed.status).toBe(200);
  });
});
