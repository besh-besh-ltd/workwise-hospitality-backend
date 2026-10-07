// Report 1.1 sheet 1 — the month series for a window that does not start on
// the 1st.
//
// generate_series stepped a month at a time from the raw `from` date, and its
// rows were joined to spend bucketed by date_trunc('month'). A window from
// 31 Aug to 30 Sep therefore produced one row, "Aug-26" at ₹0, and no September
// row at all — while the total for the same window (spendTotals) correctly read
// ₹6.0 Cr. Every calendar month the window touches must appear exactly once,
// and the month rows must add up to the window's total.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { spendByMonth, spendTotals } from "../../app/models/reportsModel.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

const BUYER = IDS.users.a1_proc_buyer;
const SCOPE = {
  userId: BUYER,
  hospitalityCompanyIds: [IDS.hospitality.A],
  companyId: IDS.companies.A,
  hotelIds: [IDS.hotels.A1],
  departmentId: null,
};
const AMOUNT = 987654.32;

// From the 15th of last month (never the 1st) to tomorrow (exclusive), in IST:
// always exactly two calendar months, and today's PO inside the window.
const today = moment.tz("Asia/Kolkata");
const FROM = today.clone().subtract(1, "month").date(15).format("YYYY-MM-DD");
const TO = today.clone().add(1, "day").format("YYYY-MM-DD");
const WINDOW = {
  from: FROM,
  to: TO,
  priorFrom: moment(FROM).subtract(1, "year").format("YYYY-MM-DD"),
  priorTo: moment(TO).subtract(1, "year").format("YYYY-MM-DD"),
};
const EXPECTED_MONTHS = [
  today.clone().subtract(1, "month").startOf("month").format("YYYY-MM-DD"),
  today.clone().startOf("month").format("YYYY-MM-DD"),
];

const seeded = { rfqIds: [], poIds: [] };

// node-pg builds a DATE as local midnight; read it back with local getters.
const ymd = (d) =>
  d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : String(d).slice(0, 10);

beforeAll(async () => {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: "spend by month window",
  });
  seeded.rfqIds.push(rfq_id);
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', 1, 0) RETURNING id`,
    [rfq_id]
  );
  const { po_id } = await makePO(db, {
    rfq_id, rfq_product_id: rp.id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: AMOUNT, quantity: 1, total_value: AMOUNT,
  });
  seeded.poIds.push(po_id);
});

afterAll(async () => {
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  await cleanupRfqs(db, seeded.rfqIds);
  await closeDb();
});

describe("spendByMonth — a window that starts mid-month", () => {
  it("lists every calendar month the window touches, once, keyed to the 1st", async () => {
    const rows = await spendByMonth(SCOPE, WINDOW);
    expect(rows.map((r) => ymd(r.month_start))).toEqual(EXPECTED_MONTHS);
  });

  it("the month rows add up to the window's total spend (Report 1.1 summary)", async () => {
    const [rows, totals] = await Promise.all([spendByMonth(SCOPE, WINDOW), spendTotals(SCOPE, WINDOW)]);
    const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
    expect(Number(totals.amount)).toBeGreaterThanOrEqual(AMOUNT - 0.01);
    expect(sum).toBeCloseTo(Number(totals.amount), 2);
  });

  it("today's PO lands in the current month's row", async () => {
    const rows = await spendByMonth(SCOPE, WINDOW);
    const current = rows.find((r) => ymd(r.month_start) === EXPECTED_MONTHS[1]);
    expect(Number(current?.amount)).toBeGreaterThanOrEqual(AMOUNT - 0.01);
  });
});
