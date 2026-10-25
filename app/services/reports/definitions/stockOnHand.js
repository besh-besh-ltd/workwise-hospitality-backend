// ============================================================================
// 7.1 — Stock on Hand
// ----------------------------------------------------------------------------
// Quantity and value of every item held at each hotel the caller can read,
// as at the end of the chosen period (today, for the current year).
//
// A position, so it is valued the way the balance is, never by summing
// movement values (a reversal at receipt cost floors the balance's value at
// 0 while the movement sum goes negative, and that residue would never
// clear):
//   - As at today or later: tbl_inv_balance as it stands (qty, avg cost,
//     value, last movement).
//   - As at a past day: per (hotel, item), the last movement before the end
//     of that day (ix_inv_movement_hotel_item_posted, newest first): its
//     qty_after and avg_cost_after, value = qty_after × avg_cost_after.
// Every (hotel, item) that has ever moved has a balance row (the ledger
// writes one with its first movement), so the balance table drives both.
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
    const today = (await db.one(`SELECT ${IST_TODAY}::text AS d`)).d;
    const current = asAtDay >= today;
    const ITEM_JOINS = `
             JOIN tbl_inv_item i ON i.id = b.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = b.hotel_id
             LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = b.hotel_id AND hi.inv_item_id = b.inv_item_id`;
    const ITEM_COLS = `b.hotel_id, h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  hi.bin_label, hi.reorder_level::float8 AS reorder_level`;
    let raw = [];
    if (hotels.length && current) {
      raw = await db.any(
        `SELECT ${ITEM_COLS},
                b.qty::float8 AS qty, b.avg_cost::float8 AS avg_cost, b.value::float8 AS value,
                b.last_movement_at AS last_at
           FROM tbl_inv_balance b
           ${ITEM_JOINS}
          WHERE b.hotel_id = ANY($1::int[])
            AND b.qty <> 0
          ORDER BY h.name, h.id, i.display_name, i.id`,
        [hotels]
      );
    } else if (hotels.length) {
      raw = await db.any(
        `SELECT ${ITEM_COLS},
                pos.qty_after::float8 AS qty, pos.avg_cost_after::float8 AS avg_cost,
                round(pos.qty_after * pos.avg_cost_after, 4)::float8 AS value, pos.posted_at AS last_at
           FROM tbl_inv_balance b
           CROSS JOIN LATERAL (
             SELECT m.qty_after, m.avg_cost_after, m.posted_at
               FROM tbl_inv_movement m
              WHERE m.hotel_id = b.hotel_id
                AND m.inv_item_id = b.inv_item_id
                AND m.posted_at < ${istDayStart("$2")}
              ORDER BY m.posted_at DESC, m.id DESC
              LIMIT 1
           ) pos
           ${ITEM_JOINS}
          WHERE b.hotel_id = ANY($1::int[])
            AND pos.qty_after <> 0
          ORDER BY h.name, h.id, i.display_name, i.id`,
        [hotels, period.to]
      );
    }

    const rows = raw.map((r) => ({
      hotel_id: Number(r.hotel_id),
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

    // Keyed by hotel id: two hotels can share a name.
    const byHotel = new Map();
    for (const r of rows) {
      const s = byHotel.get(r.hotel_id) || { hotel_name: r.hotel_name, items: 0, value: 0 };
      s.items += 1;
      s.value = round4(s.value + (r.value || 0));
      byHotel.set(r.hotel_id, s);
    }

    return {
      rows,
      summaryRows: [...byHotel.values()],
      asAt: current ? today : asAtDay,
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
      ["Valuation", "Moving weighted average, as the stock balance carries it"],
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
