// ============================================================================
// 7.7 — Near Expiry
// ----------------------------------------------------------------------------
// Batches still in stock (qty > 0) that expire within the next 30 days (IST,
// from today), and any already past expiry, per hotel, soonest first. Read
// straight from tbl_inv_batch, so it lists what the batch balances say is on
// the shelf. Batches carry no cost, so there is no value column.
//
// The report is "as of today", so the period filter does not apply.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import {
  INVENTORY_FAMILY,
  IST_TODAY,
  QTY_FMT,
  hotelNames,
  hotelsLabel,
  num,
  previewColumns,
  reportHotels,
  xlDay,
} from "../inventoryReportKit.js";

export const NEAR_EXPIRY_DAYS = 30;

const COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Batch", key: "batch_no", width: 14, type: "text" },
  { header: "Expiry Date", key: "expiry_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days to Expiry", key: "days_to_expiry", width: 13, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Status", key: "status", width: 14, type: "text" },
  { header: "Qty", key: "qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
];

const statusFor = (days) => (days < 0 ? "Expired" : days === 0 ? "Expires today" : "Expiring");

export default {
  key: "near_expiry",
  number: "7.7",
  family: INVENTORY_FAMILY,
  title: "Near Expiry",
  description: `Batches in stock that expire within ${NEAR_EXPIRY_DAYS} days or have already expired, as of today.`,
  permission: "reports.near_expiry",
  readiness: { state: "ready" },
  filters: [{ key: "hotel_ids", type: "hotels", label: "Business unit" }],

  async fetch(scope) {
    const hotels = await reportHotels(scope, "inventory");
    const raw = hotels.length
      ? await db.any(
          `SELECT h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  NULLIF(b.batch_no, '') AS batch_no, b.expiry_date::text AS expiry_date,
                  (b.expiry_date - ${IST_TODAY}) AS days_to_expiry, b.qty::float8 AS qty
             FROM tbl_inv_batch b
             JOIN tbl_inv_item i ON i.id = b.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = b.hotel_id
            WHERE b.hotel_id = ANY($1::int[])
              AND b.qty > 0
              AND b.expiry_date <= ${IST_TODAY} + $2::int
            ORDER BY b.expiry_date, h.name, h.id, i.display_name, i.id, b.batch_no`,
          [hotels, NEAR_EXPIRY_DAYS]
        )
      : [];

    const rows = raw.map((r) => {
      const days = Number(r.days_to_expiry);
      return {
        hotel_name: r.hotel_name,
        item_name: r.item_name,
        item_code: r.item_code || null,
        stock_uom: r.stock_uom,
        batch_no: r.batch_no || null,
        expiry_date: r.expiry_date,
        days_to_expiry: days,
        status: statusFor(days),
        qty: num(r.qty),
      };
    });

    return { rows, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const ws = reportSheet(wb, "Near Expiry", { footerTitle: "Near Expiry" });
    writeReportSheet(ws, {
      title: "Near Expiry",
      subtitle: `${rows.length} batch(es) expired or expiring within ${NEAR_EXPIRY_DAYS} days · Soonest first`,
      params: [
        ["As of", asOf],
        ["Business units", hotelsLabel(names)],
        ["Window", `Expiry on or before today + ${NEAR_EXPIRY_DAYS} days (IST), including expired batches`],
      ],
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, expiry_date: xlDay(r.expiry_date) })),
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
