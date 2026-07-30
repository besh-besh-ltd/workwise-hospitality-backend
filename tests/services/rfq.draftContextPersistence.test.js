// P0 regression suite — "the RFQ vanished" bug.
// ---------------------------------------------------------------------------
// Root cause (prod incident):
//   1. rfqModel.getRfqDraftById() built `rfq_form_data` WITHOUT
//      `hospitality_company_id`, so the wizard never held the value and could
//      not echo it back.
//   2. saveRfqDraft() wrote `hospitality_company_id: hospitality_company_id ||
//      null` into an UNCONDITIONAL full-column UPDATE
//      (rfqModel.updateWithTimestamp builds its SET list from every key in the
//      object). An OMITTED field therefore became an explicit NULL.
//   3. Every buyer-visibility query gates on
//      `urs.company_id = RFQ.hospitality_company_id`, and `x = NULL` is never
//      TRUE — so a single auto-save erased the RFQ from every buyer surface,
//      including the direct URL (getRfqById returns 403).
//
// The contract these tests lock in:
//   - hydration returns hospitality_company_id
//   - an ABSENT key leaves the column untouched (re-derived from the hotel when
//     it would otherwise end up NULL)
//   - an EXPLICIT null still clears an optional column (no over-correction)
//   - the RFQ stays visible in list-view and on the detail endpoint afterwards
//   - a cloned RFQ survives the same hydrate → save-draft round trip
//
// Pattern B (commit + cleanup) — saveRfqDraft opens its own db.tx.
//   npm test -- rfq.draftContextPersistence

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;

let client;

beforeAll(async () => {
  // Fixture users carry user_type = NULL; acl([2, 8]) on /save-draft and
  // /get-draft-by-id needs 2 (Buyer).
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
  client = await httpClient(BUYER);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
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

async function makeHospitalityDraft(overrides = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 0,
    is_published: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    ...overrides,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [rfq_id, overrides.hotel ?? IDS.hotels.A1, BUYER]
  );
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  return rfq_id;
}

async function hydrate(rfq_id) {
  const res = await client.get(`/api/v1/rfq/get-draft-by-id/${rfq_id}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

// Rebuild the save-draft payload the way the wizard does: from the hydrated
// form data. `omit` names the keys the (buggy) client leaves out.
function replayBody(rfq_id, formData, { omit = [], extra = {} } = {}) {
  const body = {
    rfq_id,
    comment: formData.comment,
    company_name: formData.company_name,
    response_email: formData.response_email || "",
    contact_name: formData.contact_name,
    contact_number: formData.contact_number,
    bid_end_date: formData.bid_end_date,
    location: formData.location,
    rfq_type: formData.rfq_type,
    reverse_auction: formData.reverse_auction,
    is_tender: formData.is_tender,
    title: formData.title,
    hospitality_company_id: formData.hospitality_company_id,
    hotel_id: formData.hotel_id,
    department_id: formData.department_id,
    process_id: formData.process_id,
    filters: { global: null, local: null },
    ...extra,
  };
  for (const key of omit) delete body[key];
  return body;
}

async function readContext(rfq_id) {
  return db.one(
    `SELECT hospitality_company_id, hotel_id, department_id, process_id, title,
            bid_end_date, is_tender, tender_fees, rfq_type, reverse_auction,
            comment, location, contact_name
       FROM tbl_rfq WHERE id = $1`,
    [rfq_id]
  );
}

// ===========================================================================
//  1. Hydration must surface the tenant anchor
// ===========================================================================

describe("GET /rfq/get-draft-by-id/:id — hydration payload", () => {
  it("returns hospitality_company_id inside rfq_form_data", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    expect(data.rfq_form_data).toBeDefined();
    // The wizard cannot echo back a field it was never given. This is the
    // upstream half of the bug.
    expect(data.rfq_form_data).toHaveProperty("hospitality_company_id");
    expect(data.rfq_form_data.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(data.rfq_form_data.hotel_id).toBe(IDS.hotels.A1);
  });
});

// ===========================================================================
//  2. An OMITTED field must not be written as NULL
// ===========================================================================

describe("POST /rfq/save-draft — absent keys must not null the tenant anchor", () => {
  it("replaying the hydrated draft WITHOUT hospitality_company_id leaves the column intact", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, {
        omit: ["hospitality_company_id"],
        extra: { comment: "auto-save round #1" },
      }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(after.hotel_id).toBe(IDS.hotels.A1);
  });

  it("omitting the whole hospitality block (company + hotel + dept + process) preserves every column", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, {
        omit: ["hospitality_company_id", "hotel_id", "department_id", "process_id"],
        extra: { comment: "auto-save round #2" },
      }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(after.hotel_id).toBe(IDS.hotels.A1);
    expect(after.department_id).toBe(IDS.departments.proc);
    expect(after.process_id).toBe(IDS.processes.A_P1);
  });

  it("the RFQ stays visible in list-view and on getRfqById after the round trip", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const save = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { omit: ["hospitality_company_id"] }));
    expect(save.status).toBe(200);

    const list = await client.post("/api/v1/rfq/list-view").send({ tab: "all", limit: 100 });
    expect(list.status).toBe(200);
    expect(list.body.status).toBe(1);
    const ids = (list.body.data.rows || []).map((r) => Number(r.id));
    expect(ids).toContain(Number(rfq_id));

    const detail = await client.get(`/api/v1/rfq/getRfqById/${rfq_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).not.toBe(0); // 403-shaped "no permission" payload
  });

  it("re-derives hospitality_company_id from the hotel when the stored column is already NULL", async () => {
    // Simulates an RFQ that was already wiped by the old code: the client still
    // omits the field, but the hotel is known, so the server must repair it.
    const rfq_id = await makeHospitalityDraft();
    await db.none(`UPDATE tbl_rfq SET hospitality_company_id = NULL WHERE id = $1`, [rfq_id]);

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      comment: "save after the column was nulled",
      hotel_id: IDS.hotels.A1,
      is_tender: 0,
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
  });
});

// ===========================================================================
//  2b. The same absent-key rule for every other column saveRfqDraft writes.
//
//  Verified in production: all 35 RFQs with bid_end_date = '' ALSO have
//  hospitality_company_id IS NULL — a 100% overlap, i.e. one partial save-draft
//  wipes several columns at once. The empty bid_end_date is not cosmetic: it is
//  the root cause of a separate P0, because the vendor backfill query casts
//  r.bid_end_date::timestamp and '' aborts the WHOLE query with
//  `invalid input syntax for type timestamp: ""`, emptying every newly
//  registered vendor's dashboard.
// ===========================================================================

describe("POST /rfq/save-draft — bid_end_date is never silently emptied", () => {
  it("a minimal payload that omits bid_end_date leaves the existing deadline intact", async () => {
    const rfq_id = await makeHospitalityDraft();
    const before = await readContext(rfq_id);
    expect(before.bid_end_date).toBeTruthy();

    // The exact shape that corrupted production: a partial auto-save.
    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      comment: "partial auto-save with no deadline field",
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.bid_end_date).toBe(before.bid_end_date);
    expect(after.bid_end_date).not.toBe("");
    // ...and the tenant anchor survived the same call.
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
  });

  it("replaying the hydrated draft without bid_end_date keeps the deadline", async () => {
    const rfq_id = await makeHospitalityDraft();
    const before = await readContext(rfq_id);
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { omit: ["bid_end_date"] }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.bid_end_date).toBe(before.bid_end_date);
  });

  it("an EXPLICIT empty bid_end_date still clears it (the column is NOT NULL text)", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { extra: { bid_end_date: "" } }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.bid_end_date).toBe("");
  });
});

describe("POST /rfq/save-draft — a tender must not silently become an RFQ", () => {
  async function makeTenderDraft() {
    const rfq_id = await makeHospitalityDraft({ is_tender: 1 });
    await db.none(`UPDATE tbl_rfq SET is_tender = 1, tender_fees = 5000 WHERE id = $1`, [rfq_id]);
    return rfq_id;
  }

  it("omitting is_tender leaves the row a tender (and keeps its tender_fees)", async () => {
    const rfq_id = await makeTenderDraft();

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      comment: "partial auto-save on a tender",
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.is_tender).toBe(1);
    expect(after.tender_fees).toBe(5000);
  });

  it("omitting tender_fees on a tender preserves the fee", async () => {
    const rfq_id = await makeTenderDraft();

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      is_tender: 1,
      comment: "tender save without the fee field",
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.is_tender).toBe(1);
    expect(after.tender_fees).toBe(5000);
  });

  it("an EXPLICIT is_tender: 0 still converts it, and zeroes the fee", async () => {
    const rfq_id = await makeTenderDraft();

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      is_tender: 0,
      comment: "deliberate conversion",
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.is_tender).toBe(0);
    // Invariant: a non-tender cannot carry a tender fee.
    expect(after.tender_fees).toBe(0);
  });

  it("an EXPLICIT tender_fees still updates it", async () => {
    const rfq_id = await makeTenderDraft();

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      is_tender: 1,
      tender_fees: 7500,
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.tender_fees).toBe(7500);
  });
});

describe("POST /rfq/save-draft — remaining columns follow the same rule", () => {
  it("omitting title / rfq_type / reverse_auction / comment / location leaves them intact", async () => {
    const rfq_id = await makeHospitalityDraft();
    await db.none(
      `UPDATE tbl_rfq SET reverse_auction = 1, rfq_type = 'firm' WHERE id = $1`,
      [rfq_id]
    );
    const before = await readContext(rfq_id);

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      contact_number: "+919888888888",
      filters: { global: null, local: null },
    });
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.title).toBe(before.title);
    expect(after.rfq_type).toBe("firm");
    expect(after.reverse_auction).toBe(1);
    expect(after.comment).toBe(before.comment);
    expect(after.location).toBe(before.location);
    expect(after.contact_name).toBe(before.contact_name);
  });

  it("an EXPLICIT title still updates it", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { extra: { title: "Renamed by the buyer" } }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.title).toBe("Renamed by the buyer");
  });
});

// ===========================================================================
//  3. An EXPLICIT null must still clear (no over-correction)
// ===========================================================================

describe("POST /rfq/save-draft — explicit nulls still clear optional fields", () => {
  it("department_id: null clears the column", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { extra: { department_id: null } }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.department_id).toBeNull();
    // ...and the tenant anchor is still there.
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
  });

  it("process_id: null clears the column", async () => {
    const rfq_id = await makeHospitalityDraft();
    const data = await hydrate(rfq_id);

    const res = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(rfq_id, data.rfq_form_data, { extra: { process_id: null } }));
    expect(res.status).toBe(200);

    const after = await readContext(rfq_id);
    expect(after.process_id).toBeNull();
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
  });
});

// ===========================================================================
//  4. Security: omitting the field must not bypass the ABAC create gate
// ===========================================================================

describe("POST /rfq/save-draft — ABAC gate fails closed", () => {
  it("a caller with no scope in the RFQ's company is rejected even when they omit hospitality_company_id", async () => {
    // RFQ belongs to company B / hotel B1. a1_proc_buyer has no scope there.
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.companyB_admin,
      status: 0,
      is_published: 0,
      hospitality: IDS.hospitality.B,
      hotel: IDS.hotels.B1,
      department: null,
      process: IDS.processes.B_P1,
    });
    inserted.rfqIds.push(rfq_id);

    const res = await client.post("/api/v1/rfq/save-draft").send({
      rfq_id,
      comment: "silent cross-tenant edit",
      is_tender: 0,
      filters: { global: null, local: null },
      // hospitality_company_id deliberately omitted — this used to skip the
      // scope check entirely AND null the column.
    });

    expect([400, 403]).toContain(res.status);
    const after = await readContext(rfq_id);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.B);
    expect(after.hotel_id).toBe(IDS.hotels.B1);
  });
});

// ===========================================================================
//  5. Clone → hydrate → save-draft keeps the clone visible
// ===========================================================================

describe("POST /rfq/copy → hydrate → save-draft", () => {
  it("the cloned draft keeps its hospitality_company_id and stays in list-view", async () => {
    const source_rfq_id = await makeHospitalityDraft();

    const copy = await client
      .post("/api/v1/rfq/copy")
      .send({ source_rfq_id, target_hotel_id: IDS.hotels.A1 });
    expect(copy.status).toBe(200);
    const newId = Number(copy.body?.data?.new_rfq_id);
    expect(Number.isInteger(newId)).toBe(true);
    inserted.rfqIds.push(newId);

    const data = await hydrate(newId);
    expect(data.rfq_form_data.hospitality_company_id).toBe(IDS.hospitality.A);

    const save = await client
      .post("/api/v1/rfq/save-draft")
      .send(replayBody(newId, data.rfq_form_data, { omit: ["hospitality_company_id"] }));
    expect(save.status).toBe(200);

    const after = await readContext(newId);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);

    const list = await client.post("/api/v1/rfq/list-view").send({ tab: "all", limit: 100 });
    const ids = (list.body.data.rows || []).map((r) => Number(r.id));
    expect(ids).toContain(newId);
  });
});
