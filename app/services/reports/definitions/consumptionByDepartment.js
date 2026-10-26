// ============================================================================
// 7.3 — Consumption by Department
// ----------------------------------------------------------------------------
// What each department consumed in the period: mark-outs (including those on
// arrival) less returns to stock, at movement value, per department and
// catalogue category (spec §8.7). Wastage and other adjustments are not
// consumption; they have their own report (7.4).
//
// A category is the item's first mapped catalogue variant's leaf category.
// An item with no catalogue variant (an opening-stock item, say) is
// "Uncategorised"; a movement with no department is "No department".
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import { LEAF_CATEGORY_JOIN } from "../../../models/reportsModel.js";
import {
  INVENTORY_FAMILY,
  ITEM_VARIANT_JOIN,
  QTY_FMT,
  hotelNames,
  hotelsLabel,
  istDayStart,
  num,
  periodLabel,
  round4,
  previewColumns,
  reportHotels,
} from "../inventoryReportKit.js";

const NO_DEPARTMENT = "No department";
const UNCATEGORISED = "Uncategorised";

const COLUMNS = [
  { header: "Department", key: "department_name", width: 24, type: "text" },
  { header: "Category", key: "category", width: 28, type: "text" },
  { header: "Marked Out (₹)", key: "out_value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Returned (₹)", key: "return_value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Consumption (₹)", key: "net_value", width: 16, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "% of Total", key: "share", width: 11, align: "right", numFmt: FMT.PCT, type: "percent" },
];

const ITEM_COLUMNS = [
  { header: "Department", key: "department_name", width: 22, type: "text" },
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "Category", key: "category", width: 24, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Qty Out", key: "qty_out", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Qty Returned", key: "qty_returned", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Net Qty", key: "net_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Net Value (₹)", key: "net_value", width: 15, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

export default {
  key: "consumption_by_department",
  number: "7.3",
  family: INVENTORY_FAMILY,
  title: "Consumption by Department",
  description: "Mark-outs less returns per department and category, at stock value, for the period.",
  permission: "reports.consumption_by_department",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "inventory");
    // One row per (department, hotel, item); the department × category view
    // is rolled up from it so the two sheets always agree.
    const raw = hotels.length
      ? await db.any(
          `SELECT d.title AS department_name, m.department_id, h.name AS hotel_name,
                  i.display_name AS item_name, i.item_code, i.stock_uom, cat.title AS category,
                  (-sum(m.qty)   FILTER (WHERE m.movement_type = 'MARK_OUT'))::float8  AS qty_out,
                  ( sum(m.qty)   FILTER (WHERE m.movement_type = 'RETURN_IN'))::float8 AS qty_returned,
                  (-sum(m.value) FILTER (WHERE m.movement_type = 'MARK_OUT'))::float8  AS out_value,
                  ( sum(m.value) FILTER (WHERE m.movement_type = 'RETURN_IN'))::float8 AS return_value
             FROM tbl_inv_movement m
             JOIN tbl_inv_item i ON i.id = m.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
             LEFT JOIN tbl_department d ON d.id = m.department_id
             ${ITEM_VARIANT_JOIN}
             ${LEAF_CATEGORY_JOIN}
            WHERE m.hotel_id = ANY($1::int[])
              AND m.movement_type IN ('MARK_OUT', 'RETURN_IN')
              AND m.posted_at >= ${istDayStart("$2")}
              AND m.posted_at <  ${istDayStart("$3")}
            GROUP BY d.title, m.department_id, h.name, h.id, i.display_name, i.id, i.item_code, i.stock_uom, cat.title
            ORDER BY d.title NULLS LAST, h.name, i.display_name, i.id`,
          [hotels, period.from, period.to]
        )
      : [];

    const itemRows = raw.map((r) => {
      const qtyOut = num(r.qty_out) || 0;
      const qtyReturned = num(r.qty_returned) || 0;
      const outValue = num(r.out_value) || 0;
      const returnValue = num(r.return_value) || 0;
      return {
        department_name: r.department_name || NO_DEPARTMENT,
        hotel_name: r.hotel_name,
        category: r.category || UNCATEGORISED,
        item_name: r.item_name,
        item_code: r.item_code || null,
        stock_uom: r.stock_uom,
        qty_out: qtyOut,
        qty_returned: qtyReturned,
        net_qty: round4(qtyOut - qtyReturned),
        out_value: outValue,
        return_value: returnValue,
        net_value: round4(outValue - returnValue),
      };
    });

    const groups = new Map();
    for (const r of itemRows) {
      const key = `${r.department_name}\u0000${r.category}`;
      const g = groups.get(key) || {
        department_name: r.department_name,
        category: r.category,
        out_value: 0,
        return_value: 0,
        net_value: 0,
      };
      g.out_value += r.out_value;
      g.return_value += r.return_value;
      g.net_value += r.net_value;
      groups.set(key, g);
    }
    const total = round4([...groups.values()].reduce((s, g) => s + g.net_value, 0));
    const rows = [...groups.values()]
      .map((g) => ({
        ...g,
        out_value: round4(g.out_value),
        return_value: round4(g.return_value),
        net_value: round4(g.net_value),
        share: total !== 0 ? round4(g.net_value) / total : null,
      }))
      .sort(
        (a, b) =>
          a.department_name.localeCompare(b.department_name) ||
          b.net_value - a.net_value ||
          a.category.localeCompare(b.category)
      );

    return { rows, itemRows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, itemRows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const params = [
      ["Period", periodLabel(period)],
      ["Business units", hotelsLabel(names)],
      ["Consumption", "Mark-outs (including on arrival) less returns to stock, at stock value"],
      ["Not included", "Wastage and other adjustments (see Wastage & Adjustments)"],
    ];
    const ws = reportSheet(wb, "By Department", { footerTitle: "Consumption by Department" });
    writeReportSheet(ws, {
      title: "Consumption by Department",
      subtitle: "Per department and category · All amounts in ₹",
      params,
      columns: COLUMNS.map((c) => (c.key === "share" ? { ...c, total: () => (rows.length ? 1 : null) } : c)),
      rows,
      totalLabel: "Total",
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Item", { footerTitle: "Consumption by Item" });
    writeReportSheet(ws2, {
      title: "Consumption by Item",
      subtitle: "Per department, hotel and item · Quantities in each item's stock unit",
      params,
      columns: ITEM_COLUMNS,
      rows: itemRows,
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
