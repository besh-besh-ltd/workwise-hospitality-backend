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
});

afterAll(async () => {
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
    expect(ids.sort()).toEqual([seeded.mine1, seeded.mine2].sort());
    expect(data.total).toBe(2);
    expect(data.tab_counts.all).toBe(2);
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
