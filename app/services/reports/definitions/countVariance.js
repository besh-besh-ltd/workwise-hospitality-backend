// ============================================================================
// 7.5 — Count Variance
// ----------------------------------------------------------------------------
// The lines of every count approved in the period where the counted quantity
// differed from the system's, with the value the approval posted, then a
// summary per count.
//
// Only approved counts change stock (COUNT_IN / COUNT_OUT); open, submitted
// and cancelled ones are not reported. The value is the posted movement's,
// not the count line's estimate, so it agrees with the ledger.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import {
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
  { header: "Approved (IST)", key: "approved_at", width: 17, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "Count", key: "count_number", width: 24, type: "text" },
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Scope", key: "scope", width: 10, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "System Qty", key: "system_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Counted Qty", key: "counted_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Variance Qty", key: "variance_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Value (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Reason", key: "reason", width: 28, type: "text" },
  { header: "Approved By", key: "approved_by_name", width: 20, type: "text" },
];

const SUMMARY_COLUMNS = [
  { header: "Count", key: "count_number", width: 24, type: "text" },
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Scope", key: "scope", width: 10, type: "text" },
  { header: "Approved (IST)", key: "approved_at", width: 17, align: "center", numFmt: FMT.DATE_TIME, type: "date" },
  { header: "Lines Counted", key: "lines_counted", width: 13, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Variance Lines", key: "variance_lines", width: 13, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Net Variance (₹)", key: "value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

const SCOPE_LABELS = { FULL: "Full", SELECTED: "Spot check" };

export default {
  key: "count_variance",
  number: "7.5",
  family: INVENTORY_FAMILY,
  title: "Count Variance",
  description: "Differences found by approved stock counts in the period, with the value posted.",
  permission: "reports.count_variance",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "inventory");
    const counts = hotels.length
      ? await db.any(
          `SELECT c.id, c.count_number, c.scope, c.approved_at, h.name AS hotel_name, au.name AS approved_by_name,
                  count(cl.id) FILTER (WHERE cl.counted_qty IS NOT NULL)::int AS lines_counted
             FROM tbl_inv_count c
             JOIN tbl_hospitality_company_hotels h ON h.id = c.hotel_id
             LEFT JOIN tbl_users au ON au.id = c.approved_by
             LEFT JOIN tbl_inv_count_line cl ON cl.count_id = c.id
            WHERE c.hotel_id = ANY($1::int[])
              AND c.status = 'approved'
              AND c.approved_at >= ${istDayStart("$2")}
              AND c.approved_at <  ${istDayStart("$3")}
            GROUP BY c.id, h.name, au.name
            ORDER BY c.approved_at, c.id`,
          [hotels, period.from, period.to]
        )
      : [];
    const countIds = counts.map((c) => Number(c.id));

    const raw = countIds.length
      ? await db.any(
          `SELECT cl.count_id, i.display_name AS item_name, i.item_code, i.stock_uom,
                  cl.system_qty_at_count::float8 AS system_qty, cl.counted_qty::float8 AS counted_qty,
                  cl.variance_qty::float8 AS variance_qty, cl.reason,
                  COALESCE(mv.value, 0)::float8 AS value
             FROM tbl_inv_count_line cl
             JOIN tbl_inv_count c ON c.id = cl.count_id
             JOIN tbl_inv_item i ON i.id = cl.inv_item_id
             LEFT JOIN LATERAL (
               SELECT sum(m.value) AS value
                 FROM tbl_inv_movement m
                WHERE m.source_type = 'CNT' AND m.source_id = c.id AND m.source_line_id = cl.id
                  AND m.hospitality_company_id = c.hospitality_company_id
             ) mv ON true
            WHERE cl.count_id = ANY($1::int[])
              AND cl.variance_qty IS NOT NULL AND cl.variance_qty <> 0
            ORDER BY c.approved_at, c.id, i.display_name, cl.id`,
          [countIds]
        )
      : [];

    const byCount = new Map(counts.map((c) => [Number(c.id), c]));
    const rows = raw.map((r) => {
      const c = byCount.get(Number(r.count_id));
      return {
        approved_at: new Date(c.approved_at).toISOString(),
        count_number: c.count_number || null,
        hotel_name: c.hotel_name,
        scope: SCOPE_LABELS[c.scope] || c.scope,
        item_name: r.item_name,
        item_code: r.item_code || null,
        stock_uom: r.stock_uom,
        system_qty: num(r.system_qty),
        counted_qty: num(r.counted_qty),
        variance_qty: num(r.variance_qty),
        value: num(r.value),
        reason: r.reason || null,
        approved_by_name: c.approved_by_name || null,
      };
    });

    const summaryRows = counts.map((c) => {
      const mine = raw.filter((r) => Number(r.count_id) === Number(c.id));
      return {
        count_number: c.count_number || null,
        hotel_name: c.hotel_name,
        scope: SCOPE_LABELS[c.scope] || c.scope,
        approved_at: new Date(c.approved_at).toISOString(),
        lines_counted: Number(c.lines_counted) || 0,
        variance_lines: mine.length,
        value: round4(mine.reduce((s, r) => s + Number(r.value), 0)),
      };
    });

    return { rows, summaryRows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, summaryRows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const params = [
      ["Period", `${periodLabel(period)} (by approval date)`],
      ["Business units", hotelsLabel(names)],
      ["Variance", "Counted less system quantity at the moment the line was counted"],
    ];
    const ws = reportSheet(wb, "Variances", { footerTitle: "Count Variance" });
    writeReportSheet(ws, {
      title: "Count Variance",
      subtitle: `${rows.length} variance line(s) · Negative value is a loss · All amounts in ₹`,
      params,
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, approved_at: istDate(r.approved_at) })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Count", { footerTitle: "Count Variance by Count" });
    writeReportSheet(ws2, {
      title: "Approved Counts",
      subtitle: "Every count approved in the period, with its net variance",
      params,
      columns: SUMMARY_COLUMNS,
      rows: summaryRows.map((r) => ({ ...r, approved_at: istDate(r.approved_at) })),
      totalLabel: "Total",
      generatedBy,
      asOf,
    });
    return wb;
  },
};
