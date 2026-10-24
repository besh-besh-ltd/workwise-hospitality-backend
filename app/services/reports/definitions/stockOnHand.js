// ============================================================================
// 7.1 — Stock on Hand
// ----------------------------------------------------------------------------
// Quantity and value of every item held at each hotel the caller can read,
// as at the end of the chosen period (today, for the current year).
//
// Built from the ledger, not tbl_inv_balance, so a past period reports the
// stock as it stood then: qty = Σ movement qty and value = Σ movement value up
// to the period's end. For "now" the quantity equals the balance table's
// (the ledger guarantees it); the value can differ from the balance's by a
// write-off residue (a reversal at receipt cost), and the movement sum is the
// figure every inventory report uses.
// ============================================================================

import { FMT, istDate, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import {
  INVENTORY_FAMILY,
  IST_TODAY,
  QTY_FMT,
  hotelNames,
  hotelsLabel,
  istDayStart,
  lastDayOf,
  num,
  previewColumns,
  reportHotels,
  round4,
} from "../inventoryReportKit.js";

const COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 26, type: "text" },
  { header: "Item", key: "item_name", width: 32, type: "text" },
  { header: "Item Code", key: "item_code", width: 14, type: "text" },
  { header: "Unit", key: "stock_uom", width: 8, type: "text" },
  { header: "Bin", key: "bin_label", width: 10, type: "text" },
  { header: "Qty on Hand", key: "qty", width: 13, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Avg Cost (₹)", key: "avg_cost", width: 13, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Value (₹)", key: "value", width: 15, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Reorder Level", key: "reorder_level", width: 13, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Last Movement", key: "last_movement", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
];

const SUMMARY_COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 30, type: "text" },
  { header: "Items Held", key: "items", width: 12, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Stock Value (₹)", key: "value", width: 17, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
];

export default {
  key: "stock_on_hand",
  number: "7.1",
  family: INVENTORY_FAMILY,
  title: "Stock on Hand",
  description: "Quantity and value of every item held at each hotel, as at the end of the period.",
  permission: "reports.stock_on_hand",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "As at the end of" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "inventory");
    const asAtDay = lastDayOf(period);
    const raw = hotels.length
      ? await db.any(
          `WITH held AS (
             SELECT m.hotel_id, m.inv_item_id, sum(m.qty) AS qty, sum(m.value) AS value,
                    max(m.posted_at) AS last_at
               FROM tbl_inv_movement m
              WHERE m.hotel_id = ANY($1::int[])
                AND m.posted_at < ${istDayStart("$2")}
              GROUP BY m.hotel_id, m.inv_item_id
           )
           SELECT h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  hi.bin_label, hi.reorder_level::float8 AS reorder_level,
                  held.qty::float8 AS qty, held.value::float8 AS value,
                  CASE WHEN held.qty > 0 THEN round(held.value / held.qty, 4)::float8 END AS avg_cost,
                  held.last_at
             FROM held
             JOIN tbl_inv_item i ON i.id = held.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = held.hotel_id
             LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = held.hotel_id AND hi.inv_item_id = held.inv_item_id
            WHERE held.qty <> 0
            ORDER BY h.name, h.id, i.display_name, i.id`,
          [hotels, period.to]
        )
      : [];

    const rows = raw.map((r) => ({
      hotel_name: r.hotel_name,
      item_name: r.item_name,
      item_code: r.item_code || null,
      stock_uom: r.stock_uom,
      bin_label: r.bin_label || null,
      qty: num(r.qty),
      avg_cost: num(r.avg_cost),
      value: num(r.value),
      reorder_level: num(r.reorder_level),
      last_movement: r.last_at ? new Date(r.last_at).toISOString() : null,
    }));

    const byHotel = new Map();
    for (const r of rows) {
      const s = byHotel.get(r.hotel_name) || { hotel_name: r.hotel_name, items: 0, value: 0 };
      s.items += 1;
      s.value = round4(s.value + (r.value || 0));
      byHotel.set(r.hotel_name, s);
    }

    const today = (await db.one(`SELECT ${IST_TODAY}::text AS d`)).d;
    return {
      rows,
      summaryRows: [...byHotel.values()],
      asAt: asAtDay < today ? asAtDay : today,
      hotelNames: await hotelNames(hotels),
    };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, summaryRows, asAt, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(`${asAt}T12:00:00+05:30`);
    const params = [
      ["As at", `End of ${asOf}`],
      ["Business units", hotelsLabel(names)],
      ["Valuation", "Moving weighted average; value is the sum of ledger movement values"],
    ];
    const ws = reportSheet(wb, "Stock on Hand", { footerTitle: "Stock on Hand" });
    writeReportSheet(ws, {
      title: "Stock on Hand",
      subtitle: `${rows.length} item line(s) held · All amounts in ₹`,
      params,
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, last_movement: istDate(r.last_movement) })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "By Hotel", { footerTitle: "Stock on Hand by Hotel" });
    writeReportSheet(ws2, {
      title: "Stock Value by Hotel",
      subtitle: "Items held and their value per hotel",
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
