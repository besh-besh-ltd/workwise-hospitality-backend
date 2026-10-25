// ============================================================================
// 7.6 — Slow-moving & Non-moving Stock
// ----------------------------------------------------------------------------
// Items a hotel holds that nothing has been marked out of for the last 90
// days (IST, counted back from today):
//   Non-moving  — never marked out at this hotel;
//   Slow-moving — last marked out more than 90 days ago.
//
// Only stock that is genuinely idle is named:
//   - "Outbound" means a mark-out to a department (consumption). A count loss,
//     a wastage write-off or a return to the vendor is not use, and would
//     otherwise hide an idle item for another 90 days.
//   - The stock must have been on hand for the whole window: qty > 0 at the
//     cut-off (qty_after of the last movement before it), and the balance
//     never ran out since. An item used up long ago and received again last
//     week has not had the chance to move.
//
// Driven by tbl_inv_balance (qty > 0 now), with index probes per (hotel,
// item) on ix_inv_movement_hotel_item_posted: the position at the cut-off,
// any mark-out or run-out since it (a 90-day range), and, for the rows that
// survive, the last mark-out and the day the current holding began. Quantity
// and value are the balance's (a position, not a sum of movement values).
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
  { header: "Held Since", key: "held_since", width: 14, align: "center", numFmt: FMT.DATE, type: "date" },
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
    const SAME_ITEM = `m.hotel_id = idle.hotel_id AND m.inv_item_id = idle.inv_item_id`;
    const raw = hotels.length
      ? await db.any(
          `WITH idle AS MATERIALIZED (
             SELECT b.hotel_id, b.inv_item_id, b.qty, b.value
               FROM tbl_inv_balance b
               CROSS JOIN LATERAL (
                 SELECT m.qty_after
                   FROM tbl_inv_movement m
                  WHERE m.hotel_id = b.hotel_id AND m.inv_item_id = b.inv_item_id
                    AND m.posted_at < ${cutoff}
                  ORDER BY m.posted_at DESC, m.id DESC
                  LIMIT 1
               ) at_cut
              WHERE b.hotel_id = ANY($1::int[])
                AND b.qty > 0
                AND at_cut.qty_after > 0
                AND NOT EXISTS (
                  SELECT 1
                    FROM tbl_inv_movement m
                   WHERE m.hotel_id = b.hotel_id AND m.inv_item_id = b.inv_item_id
                     AND m.posted_at >= ${cutoff}
                     AND (m.movement_type = 'MARK_OUT' OR m.qty_after <= 0)
                )
           )
           SELECT h.name AS hotel_name, i.display_name AS item_name, i.item_code, i.stock_uom,
                  idle.qty::float8 AS qty, idle.value::float8 AS value,
                  last_out.posted_at AS last_out_at, held.posted_at AS held_since,
                  (${IST_TODAY} - (held.posted_at AT TIME ZONE 'Asia/Kolkata')::date) AS days_in_store,
                  (${IST_TODAY} - (last_out.posted_at AT TIME ZONE 'Asia/Kolkata')::date) AS days_since_outbound
             FROM idle
             JOIN tbl_inv_item i ON i.id = idle.inv_item_id
             JOIN tbl_hospitality_company_hotels h ON h.id = idle.hotel_id
             LEFT JOIN LATERAL (
               SELECT m.posted_at
                 FROM tbl_inv_movement m
                WHERE ${SAME_ITEM} AND m.movement_type = 'MARK_OUT'
                ORDER BY m.posted_at DESC, m.id DESC
                LIMIT 1
             ) last_out ON true
             LEFT JOIN LATERAL (
               SELECT m.posted_at, m.id
                 FROM tbl_inv_movement m
                WHERE ${SAME_ITEM} AND m.qty_after <= 0
                ORDER BY m.posted_at DESC, m.id DESC
                LIMIT 1
             ) ran_out ON true
             CROSS JOIN LATERAL (
               SELECT m.posted_at
                 FROM tbl_inv_movement m
                WHERE ${SAME_ITEM}
                  AND m.posted_at >= COALESCE(ran_out.posted_at, '-infinity'::timestamptz)
                  AND (ran_out.id IS NULL OR (m.posted_at, m.id) > (ran_out.posted_at, ran_out.id))
                ORDER BY m.posted_at, m.id
                LIMIT 1
             ) held
            ORDER BY h.name, h.id, idle.value DESC, i.display_name, i.id`,
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
      held_since: new Date(r.held_since).toISOString(),
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
        ["Idle", `Nothing marked out in the last ${SLOW_MOVING_DAYS} days, and held without running out for at least that long`],
        ["Held since", "When the current holding began: the first movement after the balance last ran out"],
        ["Non-moving", "Never marked out at this hotel"],
      ],
      columns: COLUMNS,
      rows: rows.map((r) => ({
        ...r,
        last_outbound_at: istDate(r.last_outbound_at),
        held_since: istDate(r.held_since),
      })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
