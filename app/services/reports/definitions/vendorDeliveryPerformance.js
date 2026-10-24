// ============================================================================
// 8.3 — Vendor Delivery Performance (OTIF)
// ----------------------------------------------------------------------------
// How reliably each vendor delivers, judged per delivery row (a phase at a
// hotel) whose due date falls in the period, at the hotels where the caller
// can read GRNs.
//
// A row is judged once it can be: its due date has passed (IST), or it is
// already received or short-closed. A row due later with goods still open is
// not counted yet; nor is a row with no due date, an unallocated row (no
// hotel), or any row of a legacy order from before receiving went live.
//
//   On time  — its first receipt (the earliest posted receipt GRN allocated
//              to any of its lines) is on or before the due date.
//   In full  — every line's net accepted quantity reached the planned
//              quantity and nothing on the row was short-closed.
//   OTIF     — both.
//   Rejection %   = rejected ÷ received (accepted + rejected), over the
//                   judged rows.
//   Short-close % = short-closed ÷ planned, over the judged rows.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import { RECEIVABLE_PO_STATUSES } from "../../inventory/grnCommon.js";
import {
  IST_TODAY,
  QTY_FMT,
  RECEIVING_FAMILY,
  VENDOR_NAME,
  hotelNames,
  hotelsLabel,
  num,
  periodLabel,
  previewColumns,
  reportHotels,
  round4,
  xlDay,
} from "../inventoryReportKit.js";

/** A completed order's deliveries are history worth judging too. */
const JUDGED_PO_STATUSES = Object.freeze([...RECEIVABLE_PO_STATUSES, "completed"]);

const yesNo = (b) => (b ? "Yes" : "No");
const ratio = (a, b) => (b > 0 ? a / b : null);

const VENDOR_COLUMNS = [
  { header: "Vendor", key: "vendor_name", width: 30, type: "text" },
  { header: "Deliveries", key: "deliveries", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "On Time", key: "on_time", width: 9, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "In Full", key: "in_full", width: 9, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "OTIF", key: "otif", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "On Time %", key: "on_time_pct", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "In Full %", key: "in_full_pct", width: 10, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "OTIF %", key: "otif_pct", width: 9, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Rejection %", key: "rejection_pct", width: 11, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Short-close %", key: "short_close_pct", width: 12, align: "right", numFmt: FMT.PCT, type: "percent" },
  { header: "Avg Days Late", key: "avg_days_late", width: 12, align: "right", numFmt: "0.0", type: "int" },
];

const DELIVERY_COLUMNS = [
  { header: "PO Number", key: "po_number", width: 22, type: "text" },
  { header: "Phase", key: "phase", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Hotel", key: "hotel_name", width: 22, type: "text" },
  { header: "Vendor", key: "vendor_name", width: 28, type: "text" },
  { header: "Due Date", key: "due_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "First Receipt", key: "first_receipt", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Days Late", key: "days_late", width: 10, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Planned", key: "planned_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Received", key: "received_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Rejected", key: "rejected_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Net Accepted", key: "net_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Short-closed", key: "short_closed_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "On Time", key: "on_time_label", width: 9, align: "center", type: "text" },
  { header: "In Full", key: "in_full_label", width: 9, align: "center", type: "text" },
  { header: "OTIF", key: "otif_label", width: 8, align: "center", type: "text" },
];

export default {
  key: "vendor_delivery_performance",
  number: "8.3",
  family: RECEIVING_FAMILY,
  title: "Vendor Delivery Performance",
  description: "On-time-in-full per vendor over the delivery rows due in the period, with rejection and short-close rates.",
  permission: "reports.vendor_delivery_performance",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Due in" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "grn");
    const raw = hotels.length
      ? await db.any(
          `WITH rows_due AS (
             SELECT d.id, d.hotel_id, d.phase_no, d.due_date, d.status, d.po_id
               FROM tbl_po_delivery d
               JOIN tbl_rfq_purchase_order po ON po.id = d.po_id
              WHERE d.hotel_id = ANY($1::int[])
                AND d.due_date IS NOT NULL
                AND d.due_date >= $2::date
                AND d.due_date <  $3::date
                AND NOT po.receipt_legacy
                AND po.status::text = ANY($4::text[])
                AND (d.due_date < ${IST_TODAY} OR d.status IN ('received', 'short_closed'))
           ),
           qty AS (
             SELECT dl.delivery_id,
                    sum(dl.planned_qty) AS planned,
                    sum(dl.accepted_qty + dl.rejected_qty) AS received,
                    sum(dl.rejected_qty) AS rejected,
                    sum(dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty) AS net,
                    sum(dl.short_closed_qty) AS short_closed,
                    bool_and(dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty >= dl.planned_qty)
                      AS all_lines_full
               FROM tbl_po_delivery_line dl
              WHERE dl.delivery_id IN (SELECT id FROM rows_due)
              GROUP BY dl.delivery_id
           ),
           first_receipt AS (
             SELECT dl.delivery_id, min(g.received_at) AS first_at
               FROM tbl_grn_line_alloc a
               JOIN tbl_po_delivery_line dl ON dl.id = a.delivery_line_id
               JOIN tbl_grn_line gl ON gl.id = a.grn_line_id
               JOIN tbl_grn g ON g.id = gl.grn_id
              WHERE dl.delivery_id IN (SELECT id FROM rows_due)
                AND g.doc_type = 'RECEIPT'
                AND g.status IN ('posted', 'partially_reversed')
                AND (a.accepted_qty > 0 OR a.rejected_qty > 0)
              GROUP BY dl.delivery_id
           )
           SELECT rd.id, po.po_number, rd.phase_no, h.name AS hotel_name, po.finalized_vendor_id AS vendor_id,
                  ${VENDOR_NAME} AS vendor_name, rd.due_date::text AS due_date, fr.first_at::text AS first_receipt,
                  CASE WHEN fr.first_at IS NOT NULL THEN GREATEST(fr.first_at - rd.due_date, 0)
                       ELSE GREATEST(${IST_TODAY} - rd.due_date, 0) END AS days_late,
                  COALESCE(q.planned, 0)::float8 AS planned_qty, COALESCE(q.received, 0)::float8 AS received_qty,
                  COALESCE(q.rejected, 0)::float8 AS rejected_qty, COALESCE(q.net, 0)::float8 AS net_qty,
                  COALESCE(q.short_closed, 0)::float8 AS short_closed_qty,
                  (fr.first_at IS NOT NULL AND fr.first_at <= rd.due_date) AS on_time,
                  (COALESCE(q.all_lines_full, false) AND COALESCE(q.short_closed, 0) = 0) AS in_full
             FROM rows_due rd
             JOIN tbl_rfq_purchase_order po ON po.id = rd.po_id
             JOIN tbl_hospitality_company_hotels h ON h.id = rd.hotel_id
             LEFT JOIN qty q ON q.delivery_id = rd.id
             LEFT JOIN first_receipt fr ON fr.delivery_id = rd.id
             LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
             LEFT JOIN tbl_company vc ON vc.id = v.company_id
            ORDER BY vendor_name, rd.due_date, po.po_number, rd.phase_no, rd.id`,
          [hotels, period.from, period.to, JUDGED_PO_STATUSES]
        )
      : [];

    const deliveryRows = raw.map((r) => ({
      po_number: r.po_number || null,
      phase: Number(r.phase_no),
      hotel_name: r.hotel_name,
      vendor_id: r.vendor_id == null ? null : Number(r.vendor_id),
      vendor_name: r.vendor_name || "—",
      due_date: r.due_date,
      first_receipt: r.first_receipt || null,
      days_late: Number(r.days_late),
      planned_qty: num(r.planned_qty),
      received_qty: num(r.received_qty),
      rejected_qty: num(r.rejected_qty),
      net_qty: num(r.net_qty),
      short_closed_qty: num(r.short_closed_qty),
      on_time: !!r.on_time,
      in_full: !!r.in_full,
      otif: !!r.on_time && !!r.in_full,
      on_time_label: yesNo(r.on_time),
      in_full_label: yesNo(r.in_full),
      otif_label: yesNo(r.on_time && r.in_full),
    }));

    const byVendor = new Map();
    for (const d of deliveryRows) {
      const key = d.vendor_id ?? d.vendor_name;
      const v = byVendor.get(key) || {
        vendor_name: d.vendor_name,
        deliveries: 0,
        on_time: 0,
        in_full: 0,
        otif: 0,
        planned: 0,
        received: 0,
        rejected: 0,
        short_closed: 0,
        days_late: 0,
      };
      v.deliveries += 1;
      v.on_time += d.on_time ? 1 : 0;
      v.in_full += d.in_full ? 1 : 0;
      v.otif += d.otif ? 1 : 0;
      v.planned = round4(v.planned + d.planned_qty);
      v.received = round4(v.received + d.received_qty);
      v.rejected = round4(v.rejected + d.rejected_qty);
      v.short_closed = round4(v.short_closed + d.short_closed_qty);
      v.days_late += d.days_late;
      byVendor.set(key, v);
    }
    const rows = [...byVendor.values()]
      .map((v) => ({
        vendor_name: v.vendor_name,
        deliveries: v.deliveries,
        on_time: v.on_time,
        in_full: v.in_full,
        otif: v.otif,
        on_time_pct: ratio(v.on_time, v.deliveries),
        in_full_pct: ratio(v.in_full, v.deliveries),
        otif_pct: ratio(v.otif, v.deliveries),
        rejection_pct: ratio(v.rejected, v.received),
        short_close_pct: ratio(v.short_closed, v.planned),
        avg_days_late: v.deliveries ? Math.round((v.days_late / v.deliveries) * 10) / 10 : null,
      }))
      .sort((a, b) => b.deliveries - a.deliveries || a.vendor_name.localeCompare(b.vendor_name));

    return { rows, deliveryRows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(VENDOR_COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, deliveryRows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const params = [
      ["Period", `${periodLabel(period)} (by due date)`],
      ["Business units", hotelsLabel(names)],
      ["Judged", "Rows whose due date has passed, or already received or short-closed; legacy orders excluded"],
      ["On time", "First receipt on or before the due date"],
      ["In full", "Every line's net accepted quantity reached plan, with nothing short-closed"],
    ];
    const ws = reportSheet(wb, "By Vendor", { footerTitle: "Vendor Delivery Performance" });
    writeReportSheet(ws, {
      title: "Vendor Delivery Performance",
      subtitle: `${rows.length} vendor(s) · ${deliveryRows.length} delivery row(s) judged`,
      params,
      columns: VENDOR_COLUMNS,
      rows,
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "Deliveries", { footerTitle: "Vendor Delivery Performance — rows" });
    writeReportSheet(ws2, {
      title: "Delivery Rows",
      subtitle: "Every judged delivery row · Quantities summed over the row's lines, in the PO units",
      params,
      columns: DELIVERY_COLUMNS,
      rows: deliveryRows.map((r) => ({ ...r, due_date: xlDay(r.due_date), first_receipt: xlDay(r.first_receipt) })),
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
