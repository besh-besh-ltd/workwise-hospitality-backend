// ============================================================================
// 7.4 — Wastage & Adjustments
// ----------------------------------------------------------------------------
// Every posted stock adjustment in the period, line by line, with its reason
// and the value it wrote on or off, then a summary per reason.
//
// Built from the ADJUST_IN / ADJUST_OUT movements, so only adjustments that
// actually changed stock appear: drafts, ones awaiting approval and rejected
// ones never touched the ledger. Opening-stock imports post as OPENING, not
// as an adjustment, and are left out. Count variances have their own report.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import {
  ADJUSTMENT_REASON_LABELS,
  INVENTORY_FAMILY,
  QTY_FMT,
  hotelNames,
  hotelsLabel,
  istDayStart,
  num,
  periodLabel,
  previewColumns,
  reportHotels,
  round4,
} from "../inventoryReportKit.js";

const COLUMNS = [
  { header: "Posted (IST)", key: "posted_at", width: 17, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "Adjustment", key: "adjustment_number", width: 24, type: "text" },
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Reason", key: "reason", width: 14, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Qty", key: "qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Value (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Remarks", key: "remarks", width: 30, type: "text" },
  { header: "Raised By", key: "created_by_name", width: 20, type: "text" },
  { header: "Approved By", key: "approved_by_name", width: 20, type: "text" },
];

const SUMMARY_COLUMNS = [
  { header: "Reason", key: "reason", width: 18, type: "text" },
  { header: "Lines", key: "lines", width: 9, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Written Off (₹)", key: "value_out", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Written On (₹)", key: "value_in", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Net (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

export default {
  key: "stock_adjustments",
  number: "7.4",
  family: INVENTORY_FAMILY,
  title: "Wastage & Adjustments",
  description: "Posted stock adjustments in the period (wastage, breakage, expiry, found, corrections) with their value.",
  permission: "reports.stock_adjustments",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "inventory");
    const raw = hotels.length
      ? await db.any(
          `SELECT m.posted_at, a.adjustment_number, h.name AS hotel_name, m.reason_code,
                  i.display_name AS item_name, i.item_code, i.stock_uom,
                  m.qty::float8 AS qty, m.value::float8 AS value,
                  COALESCE(NULLIF(TRIM(al.remarks), ''), NULLIF(TRIM(a.remarks), '')) AS remarks,
                  cu.name AS created_by_name, au.name AS approved_by_name
             FROM tbl_inv_movement m
             JOIN tbl_inv_item i ON i.id = m.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
             LEFT JOIN tbl_inv_adjustment a
               ON a.id = m.source_id AND a.hospitality_company_id = m.hospitality_company_id
             LEFT JOIN tbl_inv_adjustment_line al ON al.id = m.source_line_id AND al.adjustment_id = a.id
             LEFT JOIN tbl_users cu ON cu.id = a.created_by
             LEFT JOIN tbl_users au ON au.id = a.approved_by
            WHERE m.hotel_id = ANY($1::int[])
              AND m.source_type = 'ADJ'
              AND m.movement_type IN ('ADJUST_IN', 'ADJUST_OUT')
              AND m.posted_at >= ${istDayStart("$2")}
              AND m.posted_at <  ${istDayStart("$3")}
            ORDER BY m.posted_at, m.id`,
          [hotels, period.from, period.to]
        )
      : [];

    const rows = raw.map((r) => ({
      posted_at: new Date(r.posted_at).toISOString(),
      adjustment_number: r.adjustment_number || null,
      hotel_name: r.hotel_name,
      reason: ADJUSTMENT_REASON_LABELS[r.reason_code] || r.reason_code || null,
      item_name: r.item_name,
      item_code: r.item_code || null,
      stock_uom: r.stock_uom,
      qty: num(r.qty),
      value: num(r.value),
      remarks: r.remarks || null,
      created_by_name: r.created_by_name || null,
      approved_by_name: r.approved_by_name || null,
    }));

    const byReason = new Map();
    for (const r of rows) {
      const key = r.reason || "—";
      const s = byReason.get(key) || { reason: key, lines: 0, value_out: 0, value_in: 0, value: 0 };
      s.lines += 1;
      if (r.value < 0) s.value_out = round4(s.value_out - r.value);
      else s.value_in = round4(s.value_in + r.value);
      s.value = round4(s.value + r.value);
      byReason.set(key, s);
    }
    const summaryRows = [...byReason.values()].sort((a, b) => a.value - b.value || a.reason.localeCompare(b.reason));

    return { rows, summaryRows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, summaryRows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const params = [
      ["Period", periodLabel(period)],
      ["Business units", hotelsLabel(names)],
      ["Included", "Adjustments posted to stock; drafts, pending and rejected ones changed nothing"],
    ];
    const ws = reportSheet(wb, "Adjustments", { footerTitle: "Wastage & Adjustments" });
    writeReportSheet(ws, {
      title: "Wastage & Adjustments",
      subtitle: `${rows.length} adjustment line(s) · Negative value is stock written off · All amounts in ₹`,
      params,
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, posted_at: istDate(r.posted_at) })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Reason", { footerTitle: "Adjustments by Reason" });
    writeReportSheet(ws2, {
      title: "Adjustments by Reason",
      subtitle: "Value written off and on per reason",
      params,
      columns: SUMMARY_COLUMNS,
      rows: summaryRows,
      totalLabel: "Total",
      generatedBy,
      asOf,
    });
    return wb;
  },
};
