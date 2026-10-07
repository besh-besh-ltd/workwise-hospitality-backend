// POST /rfq/list-view — `filters.mine`.
// ---------------------------------------------------------------------------
// The dashboard's "My drafts" / "My active RFQs" cards count only RFQs the
// caller CREATED, but their "View all" link landed on the listing, which had
// no creator filter — so it showed every RFQ in the caller's scope and the
// numbers on either side of the click disagreed.
//
// Contract:
//   - filters.mine = true keeps only rows with created_by = the caller
//     (derived from the JWT — never a client-supplied user id);
//   - tab counts and facets are computed over the same "mine" set;
//   - absent / false leaves the listing unchanged.
//
// Pattern B (commit + cleanup).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const { default: rfqModel } = await import("../../app/models/rfqModel.js");

const CALLER = IDS.users.a1_proc_buyer;
const OTHER = IDS.users.a1_proc_finance;
const TAG = `MINE-${Date.now()}`;
const inserted = [];
const seeded = {};

async function rfq(createdBy, title) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy, status: 1, is_published: 1, is_tender: 0,
    hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    department: IDS.departments.proc, process: IDS.processes.A_P1,
    title: `${TAG} ${title}`,
  });
  inserted.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  return rfq_id;
}

beforeAll(async () => {
  seeded.mine1 = await rfq(CALLER, "mine one");
  seeded.mine2 = await rfq(CALLER, "mine two");
  seeded.theirs = await rfq(OTHER, "someone else's");
  // An early draft saved before a company context existed (prod: RFQ 1128) —
  // hospitality_company_id NULL, still mapped to the creator's hotel. The
  // "My drafts" widget counts it, so its View-all must list it.
  seeded.nullCompanyDraft = await rfq(CALLER, "early draft, no company");
  await db.none(
    `UPDATE tbl_rfq SET hospitality_company_id = NULL, hotel_id = NULL, is_published = 0, status = 1 WHERE id = $1`,
    [seeded.nullCompanyDraft]
  );
  // Prod 1128's shape: no company, no hotel column, one hotel mapping.
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`,
    [seeded.nullCompanyDraft, IDS.hotels.A1, CALLER]
  );
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted]);
  await closeDb();
});

const list = async (body) => {
  const client = await httpClient(CALLER);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", search: TAG, limit: 100, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
};

describe("POST /rfq/list-view filters.mine", () => {
  it("without the filter the caller sees every RFQ in scope, including other creators'", async () => {
    const data = await list({});
    const ids = data.rows.map((r) => Number(r.id));
    expect(ids).toEqual(expect.arrayContaining([seeded.mine1, seeded.mine2, seeded.theirs]));
  });

  it("filters.mine keeps only RFQs the caller created, and counts over that set", async () => {
    const data = await list({ filters: { mine: true } });
    const ids = data.rows.map((r) => Number(r.id));
    expect(ids.sort()).toEqual([seeded.mine1, seeded.mine2, seeded.nullCompanyDraft].sort());
    expect(data.total).toBe(3);
    expect(data.tab_counts.all).toBe(3);
  });

  it("the drafts tab lists the caller's own company-less draft, as the My-drafts widget counts it", async () => {
    const data = await list({ tab: "drafts", filters: { mine: true } });
    expect(data.rows.map((r) => Number(r.id))).toEqual([seeded.nullCompanyDraft]);
    expect(data.tab_counts.drafts).toBe(1);
  });

  it("another user never sees that company-less draft", async () => {
    const client = await httpClient(OTHER);
    const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", search: TAG, limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r) => Number(r.id))).not.toContain(seeded.nullCompanyDraft);
  });

  it("the creator filter is applied in SQL, before the fetch cap", async () => {
    // Cap of 1: the newest RFQ in the caller's scope matching the tag is
    // someone else's. Filtering after the cap would return nothing of mine.
    const newest = await rfqModel.getRfqListViewRows(1, CALLER, TAG, undefined);
    expect(newest.map((r) => Number(r.id))).toEqual([seeded.nullCompanyDraft]);
    await db.none(`UPDATE tbl_rfq SET "timestamp" = NOW() + INTERVAL '1 minute' WHERE id = $1`, [seeded.theirs]);
    try {
      const all = await rfqModel.getRfqListViewRows(1, CALLER, TAG, undefined);
      expect(all.map((r) => Number(r.id))).toEqual([seeded.theirs]);
      const mine = await rfqModel.getRfqListViewRows(1, CALLER, TAG, undefined, { mine: true });
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].created_by)).toBe(CALLER);
    } finally {
      await db.none(`UPDATE tbl_rfq SET "timestamp" = NOW() WHERE id = $1`, [seeded.theirs]);
    }
  });

  it("accepts the string form a query-string round trip produces", async () => {
    const data = await list({ filters: { mine: "true" } });
    expect(data.rows.map((r) => Number(r.id))).not.toContain(seeded.theirs);
  });

  it("mine: false is the same as no filter", async () => {
    const data = await list({ filters: { mine: false } });
    expect(data.rows.map((r) => Number(r.id))).toContain(seeded.theirs);
  });
});
