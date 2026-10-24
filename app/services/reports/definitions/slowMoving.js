// ============================================================================
// 7.6 — Slow-moving & Non-moving Stock
// ----------------------------------------------------------------------------
// Items a hotel holds (qty > 0) that nothing has been marked out of for the
// last 90 days (IST, counted back from today):
//   Non-moving  — never marked out since it arrived;
//   Slow-moving — last marked out more than 90 days ago.
//
// Two choices, both so the list only names stock that is genuinely idle:
//   - "Outbound" means a mark-out to a department (consumption). A count loss,
//     a wastage write-off or a return to the vendor is not use, and would
//     otherwise hide an idle item for another 90 days.
//   - The item must have been in the store for the whole window (its first
//     movement at the hotel is older than 90 days); stock received last week
//     has not had the chance to move.
//
// Quantity and value are the ledger sums to date (value = Σ movement value).
// The report is "as of today", so the period filter does not apply.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
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
} from "../inventoryReportKit.js";

export const SLOW_MOVING_DAYS = 90;

const COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Status", key: "status", width: 13, type: "text" },
  { header: "Qty on Hand", key: "qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Value (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Last Mark-out", key: "last_outbound_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days Since Mark-out", key: "days_since_outbound", width: 14, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "In Store Since", key: "first_in_at", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days in Store", key: "days_in_store", width: 12, align: "right", numFmt: FMT.INT, type: "int" },
];

export default {
  key: "slow_moving",
  number: "7.6",
  family: INVENTORY_FAMILY,
  title: "Slow-moving & Non-moving Stock",
  description: `Stock held with nothing marked out for ${SLOW_MOVING_DAYS} days or more, as of today.`,
  permission: "reports.slow_moving",
  readiness: { state: "ready" },
  filters: [{ key: "hotel_ids", type: "hotels", label: "Business unit" }],

  async fetch(scope) {
    const hotels = await reportHotels(scope, "inventory");
    const cutoff = `((${IST_TODAY} - $2::int)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    const raw = hotels.length
      ? await db.any(
          `WITH held AS (
             SELECT m.hotel_id, m.inv_item_id, sum(m.qty) AS qty, sum(m.value) AS value,
                    min(m.posted_at) AS first_in_at,
                    max(m.posted_at) FILTER (WHERE m.movement_type = 'MARK_OUT') AS last_out_at
               FROM tbl_inv_movement m
              WHERE m.hotel_id = ANY($1::int[])
              GROUP BY m.hotel_id, m.inv_item_id
           )
           SELECT h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  held.qty::float8 AS qty, held.value::float8 AS value, held.first_in_at, held.last_out_at,
                  (${IST_TODAY} - (held.first_in_at AT TIME ZONE 'Asia/Kolkata')::date) AS days_in_store,
                  (${IST_TODAY} - (held.last_out_at AT TIME ZONE 'Asia/Kolkata')::date) AS days_since_outbound
             FROM held
             JOIN tbl_inv_item i ON i.id = held.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = held.hotel_id
            WHERE held.qty > 0
              AND held.first_in_at < ${cutoff}
              AND (held.last_out_at IS NULL OR held.last_out_at < ${cutoff})
            ORDER BY h.name, h.id, held.value DESC, i.display_name, i.id`,
          [hotels, SLOW_MOVING_DAYS]
        )
      : [];

    const rows = raw.map((r) => ({
      hotel_name: r.hotel_name,
      item_name: r.item_name,
      item_code: r.item_code || null,
      stock_uom: r.stock_uom,
      status: r.last_out_at ? "Slow-moving" : "Non-moving",
      qty: num(r.qty),
      value: num(r.value),
      last_outbound_at: r.last_out_at ? new Date(r.last_out_at).toISOString() : null,
      days_since_outbound: num(r.days_since_outbound),
      first_in_at: new Date(r.first_in_at).toISOString(),
      days_in_store: num(r.days_in_store),
    }));

    return { rows, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const ws = reportSheet(wb, "Slow-moving", { footerTitle: "Slow-moving & Non-moving Stock" });
    writeReportSheet(ws, {
      title: "Slow-moving & Non-moving Stock",
      subtitle: `${rows.length} item line(s) idle for ${SLOW_MOVING_DAYS}+ days · All amounts in ₹`,
      params: [
        ["As of", asOf],
        ["Business units", hotelsLabel(names)],
        ["Idle", `Nothing marked out in the last ${SLOW_MOVING_DAYS} days, and in store for at least that long`],
        ["Non-moving", "Never marked out at this hotel"],
      ],
      columns: COLUMNS,
      rows: rows.map((r) => ({
        ...r,
        last_outbound_at: istDate(r.last_outbound_at),
        first_in_at: istDate(r.first_in_at),
      })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
