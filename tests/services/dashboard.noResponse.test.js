// Integration tests for GET /api/v1/dashboard-v2/no-response.
//
// Drill-down behind the Action Centre "No responses" card (CSV Sr 228):
// published RFQs that have received zero vendor quotes, segregated into:
//   - active  : bid window still open  (bid_end_date >= today, or blank)
//   - expired : bid window has passed  (bid_end_date <  today)
//
// Product-level tests over real HTTP against the local Postgres seed.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  insertVendorQuote,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/dashboard-v2/no-response";

function bidDate(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
}

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  await cleanupRfqs(db, inserted.rfqIds);
});

async function fetchNoResponse() {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client.get(ENDPOINT).query({ hotel_ids: String(IDS.hotels.A1) });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

describe("GET /dashboard-v2/no-response — auth", () => {
  it("returns 401/403 without a JWT", async () => {
    const client = await httpClient(null);
    const res = await client.get(ENDPOINT);
    expect([401, 403]).toContain(res.status);
  });
});

describe("GET /dashboard-v2/no-response — bid-window segregation (Sr 228)", () => {
  it("puts a no-response RFQ with a future bid_end_date in `active`", async () => {
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: bidDate(5 * 86400_000), // 5 days ahead
      title: "Active no-response RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const data = await fetchNoResponse();
    expect(data.active.some((r) => r.id === rfq_id)).toBe(true);
    expect(data.expired.some((r) => r.id === rfq_id)).toBe(false);
  });

  it("puts a no-response RFQ with a past bid_end_date in `expired`", async () => {
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: bidDate(-3 * 86400_000), // 3 days ago
      title: "Expired no-response RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const data = await fetchNoResponse();
    expect(data.expired.some((r) => r.id === rfq_id)).toBe(true);
    expect(data.active.some((r) => r.id === rfq_id)).toBe(false);
  });

  it("excludes an RFQ that has received a vendor quote", async () => {
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: bidDate(5 * 86400_000),
      title: "Responded RFQ",
    });
    inserted.rfqIds.push(rfq_id);
    await insertVendorQuote(db, { rfq_id, vendor_user_id: IDS.users.vendor_alpha });

    const data = await fetchNoResponse();
    expect(data.active.some((r) => r.id === rfq_id)).toBe(false);
    expect(data.expired.some((r) => r.id === rfq_id)).toBe(false);
  });
});
