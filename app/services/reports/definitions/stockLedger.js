// ============================================================================
// 7.2 — Stock Ledger (bin card)
// ----------------------------------------------------------------------------
// Every stock movement in the period at the hotels the caller can read, per
// item in posting order, with the document that caused it and the running
// balance after it. The ledger is append-only, so this is the audit record of
// how each balance came to be.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import { REPORT_ROW_CAP } from "../../../models/reportsModel.js";
import {
  ADJUSTMENT_REASON_LABELS,
  DOC_JOINS,
  DOC_NUMBER,
  INVENTORY_FAMILY,
  MOVEMENT_LABELS,
  QTY_FMT,
  hotelNames,
  hotelsLabel,
  istDayStart,
  num,
  periodLabel,
  previewColumns,
  reportHotels,
} from "../inventoryReportKit.js";

const COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Posted (IST)", key: "posted_at", width: 17, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "Movement", key: "movement", width: 17, type: "text" },
  { header: "Document", key: "doc_number", width: 24, type: "text" },
  { header: "Department", key: "department_name", width: 18, type: "text" },
  { header: "Reason", key: "reason", width: 14, type: "text" },
  { header: "Batch", key: "batch_no", width: 12, type: "text" },
  { header: "Qty In", key: "qty_in", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Qty Out", key: "qty_out", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Unit Cost (₹)", key: "unit_cost", width: 13, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Value (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Balance Qty", key: "qty_after", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Posted By", key: "posted_by_name", width: 20, type: "text" },
];

export default {
  key: "stock_ledger",
  number: "7.2",
  family: INVENTORY_FAMILY,
  title: "Stock Ledger",
  description: "Every stock movement in the period, item by item, with its document and running balance.",
  permission: "reports.stock_ledger",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "inventory");
    const raw = hotels.length
      ? await db.any(
          `SELECT h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  m.posted_at, m.movement_type, ${DOC_NUMBER} AS doc_number, d.title AS department_name,
                  m.reason_code, m.batch_no, m.qty::float8 AS qty, m.unit_cost::float8 AS unit_cost,
                  m.value::float8 AS value, m.qty_after::float8 AS qty_after,
                  COALESCE(u.name, tk.name) AS posted_by_name
             FROM tbl_inv_movement m
             JOIN tbl_inv_item i ON i.id = m.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
             LEFT JOIN tbl_department d ON d.id = m.department_id
             LEFT JOIN tbl_users u ON u.id = m.posted_by
             ${DOC_JOINS}
             LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id
            WHERE m.hotel_id = ANY($1::int[])
              AND m.posted_at >= ${istDayStart("$2")}
              AND m.posted_at <  ${istDayStart("$3")}
            ORDER BY h.name, h.id, i.display_name, i.id, m.posted_at, m.id
            LIMIT $4`,
          [hotels, period.from, period.to, REPORT_ROW_CAP]
        )
      : [];

    const rows = raw.map((r) => ({
      hotel_name: r.hotel_name,
      item_name: r.item_name,
      item_code: r.item_code || null,
      stock_uom: r.stock_uom,
      posted_at: new Date(r.posted_at).toISOString(),
      movement: MOVEMENT_LABELS[r.movement_type] || r.movement_type,
      doc_number: r.doc_number || null,
      department_name: r.department_name || null,
      reason: r.reason_code ? ADJUSTMENT_REASON_LABELS[r.reason_code] || r.reason_code : null,
      batch_no: r.batch_no || null,
      qty_in: r.qty > 0 ? num(r.qty) : null,
      qty_out: r.qty < 0 ? -num(r.qty) : null,
      unit_cost: num(r.unit_cost),
      value: num(r.value),
      qty_after: num(r.qty_after),
      posted_by_name: r.posted_by_name || null,
    }));

    return { rows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const ws = reportSheet(wb, "Stock Ledger", { footerTitle: "Stock Ledger" });
    writeReportSheet(ws, {
      title: "Stock Ledger",
      subtitle: `${rows.length} movement(s) · Per item in posting order · All amounts in ₹`,
      params: [
        ["Period", periodLabel(period)],
        ["Business units", hotelsLabel(names)],
        ["Balance Qty", "The item's quantity at the hotel straight after the movement"],
      ],
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, posted_at: istDate(r.posted_at) })),
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
