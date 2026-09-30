// Date-window contract for every windowed dashboard endpoint (SPEC rule 1) and
// the "queues are never windowed" rule (SPEC rule 2).
//
// The FE sends IST calendar days: `end_date=<today>`. The old SQL compared
// `col BETWEEN $start AND $end`, which Postgres reads as `<= <today> 00:00`, so
// everything created today vanished (prod, 28 Sep 2026: 3 POs / ₹3.98 L and 5
// RFQs that closed with zero quotes). PO timestamps are timestamptz and were
// additionally compared against naive dates, shifting every boundary 5h30m on
// prod's UTC session.
//
// The boundary tests pin rows at explicit IST instants, so they assert the
// same thing under any Postgres session zone. Run both ways:
//   TEST_RUN_ID=x npm test -- --testPathPatterns dashboard.dateWindow
//   PGOPTIONS="-c timezone=UTC" TEST_RUN_ID=x npm test -- --testPathPatterns dashboard.dateWindow

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
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const BUYER = IDS.users.a1_proc_buyer;
const HOTEL = String(IDS.hotels.A1);
const istDay = (offsetDays = 0) => moment.tz("Asia/Kolkata").add(offsetDays, "day").format("YYYY-MM-DD");

const inserted = { rfqIds: [], poIds: [], approvalRfqIds: [] };
beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
  inserted.approvalRfqIds = [];
});
afterEach(async () => {
  await cleanupApprovalInstances(db, "RFQ", inserted.approvalRfqIds);
  await cleanupPurchaseOrders(db, inserted.poIds);
  await cleanupRfqs(db, inserted.rfqIds);
});

async function get(path, query, user = BUYER) {
  const client = await httpClient(user);
  const res = await client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: HOTEL, ...query });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

async function seedRfq(extra = {}) {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    is_published: 1,
    status: 1,
    title: "Date window RFQ",
    ...extra,
  });
  inserted.rfqIds.push(rfq_id);
  return rfq_id;
}

/** An approved PO whose created_at is pinned to an exact IST wall-clock time. */
async function seedPoAtIst(istWallClock, amount) {
  const rfq_id = await seedRfq();
  const { rfq_product_id } = await addProductToRfq(db, rfq_id);
  const { po_id } = await makePO(db, {
    rfq_id,
    rfq_product_id,
    vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A,
    status: "approved",
    unit_price: amount,
    quantity: 1,
    total_value: amount,
  });
  inserted.poIds.push(po_id);
  await db.none(
    `UPDATE tbl_rfq_purchase_order SET created_at = ($2::timestamp AT TIME ZONE 'Asia/Kolkata') WHERE id = $1`,
    [po_id, istWallClock]
  );
  return po_id;
}

describe("windowed endpoints include TODAY when end_date is today (IST)", () => {
  it("procurement-snapshot counts an RFQ and a PO created just now", async () => {
    const q = { start_date: istDay(), end_date: istDay() };
    const before = await get("procurement-snapshot", q);
    await seedPoAtIst(moment.tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"), 1234);
    const after = await get("procurement-snapshot", q);
    expect(after.total_rfqs - before.total_rfqs).toBe(1);
    expect(after.pos_issued - before.pos_issued).toBe(1);
    expect(after.total_spend - before.total_spend).toBeCloseTo(1234, 2);
  });

  it("category-insights and abc-analysis count a PO created just now", async () => {
    const q = { start_date: istDay(), end_date: istDay() };
    const cBefore = await get("category-insights", q);
    const aBefore = await get("abc-analysis", q);
    await seedPoAtIst(moment.tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"), 777);
    const cAfter = await get("category-insights", q);
    const aAfter = await get("abc-analysis", q);
    expect(cAfter.total_spend - cBefore.total_spend).toBeCloseTo(777, 2);
    expect(aAfter.total_value - aBefore.total_value).toBeCloseTo(777, 2);
  });

  it("my-drafts shows a draft created just now", async () => {
    const q = { start_date: istDay(), end_date: istDay() };
    const before = await get("my-drafts", q);
    await seedRfq({ is_published: 0, status: 0, title: "Draft today" });
    const after = await get("my-drafts", q);
    expect(after.count - before.count).toBe(1);
  });
});

describe("IST day boundaries on a timestamptz column (po.created_at)", () => {
  it("00:30 IST today is today; 23:50 IST yesterday is yesterday", async () => {
    const today = istDay();
    const yesterday = istDay(-1);
    const todayQ = { start_date: today, end_date: today };
    const yestQ = { start_date: yesterday, end_date: yesterday };
    const tBefore = await get("procurement-snapshot", todayQ);
    const yBefore = await get("procurement-snapshot", yestQ);

    await seedPoAtIst(`${today} 00:30:00`, 100);
    await seedPoAtIst(`${yesterday} 23:50:00`, 10);

    const tAfter = await get("procurement-snapshot", todayQ);
    const yAfter = await get("procurement-snapshot", yestQ);
    expect(tAfter.total_spend - tBefore.total_spend).toBeCloseTo(100, 2);
    expect(yAfter.total_spend - yBefore.total_spend).toBeCloseTo(10, 2);
  });
});

describe("date parameters", () => {
  it("a malformed date is treated as 'no bound', never a 500", async () => {
    const data = await get("procurement-snapshot", { start_date: "not-a-date", end_date: "2026-02-31" });
    expect(typeof data.total_rfqs).toBe("number");
  });

  it("no start_date means all time (the FE's 'All' sends none)", async () => {
    const all = await get("procurement-snapshot", { end_date: istDay() });
    const bounded = await get("procurement-snapshot", { start_date: istDay(), end_date: istDay() });
    expect(all.total_rfqs).toBeGreaterThanOrEqual(bounded.total_rfqs);
  });

  it("an inverted range is swapped rather than returning nothing", async () => {
    const rfqBefore = await get("procurement-snapshot", { start_date: istDay(), end_date: istDay(-30) });
    await seedRfq();
    const rfqAfter = await get("procurement-snapshot", { start_date: istDay(), end_date: istDay(-30) });
    expect(rfqAfter.total_rfqs - rfqBefore.total_rfqs).toBe(1);
  });
});

describe("queues ignore the date range (SPEC rule 2)", () => {
  it("an approval raised long before start_date is still pending in the Action Centre, the banner and the list", async () => {
    const approver = IDS.users.a1_proc_commApp;
    const rfq_id = await seedRfq({ is_published: 0, status: 3, title: "Old approval" });
    await makeApprovalInstanceWithApprover(db, {
      entity_type: "RFQ",
      entity_id: rfq_id,
      approver_user_id: approver,
      policy_id: IDS.policies.A1_P1_RFQ,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      created_ago_hours: 24 * 400,
    });
    inserted.approvalRfqIds.push(rfq_id);

    const q = { start_date: istDay(), end_date: istDay() };
    const ac = await get("action-center", q, approver);
    const acAll = await get("action-center", {}, approver);
    const banner = await get("buyer-status-banner", q, approver);
    const list = await get("pending-approvals", q, approver);

    expect(ac.pending_approvals).toBe(acAll.pending_approvals);
    expect(list.some((r) => r.entity_type === "RFQ" && r.rfq_id === rfq_id)).toBe(true);
    expect(banner.counts.pending_approvals).toBe(ac.pending_approvals);
    expect(list.length).toBe(ac.pending_approvals);
  });
});
