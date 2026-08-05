// Integration tests for GET /api/v1/vendor-dashboard/status-banner.
//
// Vendor feedback (Sr 335): "You have N PO to accept" is a WIN — the vendor was
// awarded an order — so the banner should read as a positive (green) state, not
// an amber "action needed" warning. We use vendor_epsilon (no seeded activity)
// for isolation and seed a single acceptance-pending PO.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/vendor-dashboard/status-banner";
const inserted = { rfqIds: [], poIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
});

afterEach(async () => {
  await cleanupPurchaseOrders(db, inserted.poIds);
  await cleanupRfqs(db, inserted.rfqIds);
});

describe("GET /vendor-dashboard/status-banner — PO to accept is a positive 'win' state (Sr 335)", () => {
  it("returns mode = 'win' when the only actionable item is a PO awaiting acceptance", async () => {
    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      // Explicit NAIVE IST wall clock. Omitting this inherits the makeRFQ
      // default, which is `new Date(...).toISOString()` — a UTC wall clock
      // written into a column the app reads as IST, i.e. a silent 5h30m shift.
      // At +7 days it is far enough out to be harmless, but the test should not
      // depend on that: `mode` must be 'win' because the PO is the ONLY
      // actionable item, and a bid window drifting near a boundary would let
      // closing_soon fire and flip the mode to 'action_needed'.
      bid_end_date: moment.tz("Asia/Kolkata").add(7, "days").format("YYYY-MM-DD HH:mm:ss"),
      title: "Win-state RFQ",
    });
    inserted.rfqIds.push(rfq_id);
    const { rfq_product_id } = await addProductToRfq(db, rfq_id);
    const { po_id } = await makePO(db, {
      rfq_id,
      rfq_product_id,
      vendor_user_id: IDS.users.vendor_epsilon,
      company_id: IDS.companies.A,
      status: "acceptance_pending",
    });
    inserted.poIds.push(po_id);

    const client = await httpClient(IDS.users.vendor_epsilon);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    expect(res.body.data.mode).toBe("win");
    expect(res.body.data.counts.po_acceptance_pending).toBeGreaterThanOrEqual(1);
  });
});
