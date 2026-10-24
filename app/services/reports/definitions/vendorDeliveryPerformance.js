// ============================================================================
// 8.3 — Vendor Delivery Performance (OTIF)
// ----------------------------------------------------------------------------
// How reliably each vendor delivers, judged per delivery row (a phase at a
// hotel) whose due date falls in the period, at the hotels where the caller
// can read GRNs.
//
// A row is in scope once it can be judged: its due date has passed (IST), or
// it is already received or short-closed. A row due later with goods still
// open is not counted yet; nor is a row with no due date, an unallocated row
// (no hotel), or any row of a legacy order from before receiving went live.
//
// Short-closes are split by who caused them (SHORT_CLOSE_ATTRIBUTION below).
// Only the closes in force count: every credit-return close, plus the buyer's
// own closes since the line's last reopen (a reopen takes back the line's
// whole non-RTV net, shortCloseService.reopenShortClose).
//   - A row with a buyer-side short-close (and no vendor-side one) is not
//     assessed: it is excluded from on-time, in-full and OTIF, not failed.
//     The buyer changed the order; the vendor did not miss it.
//   - A vendor-side short-close fails in-full, whatever else is on the row.
//
//   On time  — its first receipt (the earliest posted receipt GRN allocated
//              to any of its lines) is on or before the due date.
//   In full  — every line's net accepted quantity reached the planned
//              quantity, and nothing on the row was short-closed for a
//              vendor reason.
//   OTIF     — both. Counted over the assessed rows.
//
// The two rates are value-weighted, so lines in kg, litres and cases add up:
// each line's quantity × its PO line rate (unit_price, per PO unit; delivery
// quantities are in PO units). Both run over every row in scope, buyer-closed
// rows included (what arrived was still inspected; what was planned still
// stood until the buyer closed it):
//   Rejection %   = Σ rejected value ÷ Σ received (accepted + rejected) value
//   Short-close % = Σ vendor-side short-closed value
//                   ÷ Σ (planned − buyer-side short-closed) value
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import { RECEIVABLE_PO_STATUSES } from "../../inventory/grnCommon.js";
import {
  IST_TODAY,
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

/**
 * Who a short-close reason (B5's SHORT_CLOSE_REASONS) is attributed to.
 *   vendor — the vendor failed the order: it cannot supply, or will not at
 *            the PO price. Counts against in-full and short-close %.
 *   buyer  — the buyer changed the order: no longer needed, substituted with
 *            something else, or "other" (no reason given against the vendor,
 *            so none is assumed). The row is excluded, not failed.
 * A close written by a CREDIT return to vendor (rtv_id set, reason 'other')
 * is vendor-side whatever its reason: the goods came back as unfit and were
 * credited instead of replaced.
 */
export const SHORT_CLOSE_ATTRIBUTION = Object.freeze({
  vendor_cannot_supply: "vendor",
  price_dispute: "vendor",
  no_longer_needed: "buyer",
  substituted: "buyer",
  other: "buyer",
});
export const VENDOR_SHORT_CLOSE_REASONS = Object.freeze(
  Object.keys(SHORT_CLOSE_ATTRIBUTION).filter((k) => SHORT_CLOSE_ATTRIBUTION[k] === "vendor")
);

const yesNo = (b) => (b ? "Yes" : "No");
const ratio = (a, b) => (b > 0 ? a / b : null);

const VENDOR_COLUMNS = [
  { header: "Vendor", key: "vendor_name", width: 30, type: "text" },
  { header: "Deliveries", key: "deliveries", width: 11, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Buyer-closed", key: "buyer_closed", width: 12, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
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
  { header: "Planned (₹)", key: "planned_value", width: 13, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Received (₹)", key: "received_value", width: 13, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Rejected (₹)", key: "rejected_value", width: 13, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Net Accepted (₹)", key: "net_value", width: 15, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Vendor Short-close (₹)", key: "vendor_short_closed_value", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Buyer Short-close (₹)", key: "buyer_short_closed_value", width: 16, align: "right", numFmt: FMT.INR, type: "money" },
  { header: "Assessed", key: "assessed_label", width: 22, type: "text" },
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
    const VENDOR_SIDE = `(sc.rtv_id IS NOT NULL OR COALESCE(sc.reason_code, '') = ANY($5::text[]))`;
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
           lines AS (
             SELECT dl.id, dl.delivery_id, dl.planned_qty, dl.accepted_qty, dl.rejected_qty,
                    dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty AS net,
                    COALESCE(pop.unit_price, 0) AS rate
               FROM tbl_po_delivery_line dl
               JOIN tbl_purchase_order_product pop ON pop.id = dl.po_line_id
              WHERE dl.delivery_id IN (SELECT id FROM rows_due)
           ),
           last_reopen AS (
             SELECT sc.delivery_line_id, max(sc.id) AS id
               FROM tbl_po_short_close sc
              WHERE sc.delivery_line_id IN (SELECT id FROM lines)
                AND sc.action = 'reopen'
              GROUP BY sc.delivery_line_id
           ),
           closed AS (
             SELECT sc.delivery_line_id,
                    COALESCE(sum(sc.qty) FILTER (WHERE ${VENDOR_SIDE}), 0) AS vendor_sc,
                    COALESCE(sum(sc.qty) FILTER (WHERE NOT ${VENDOR_SIDE}), 0) AS buyer_sc
               FROM tbl_po_short_close sc
               LEFT JOIN last_reopen lr ON lr.delivery_line_id = sc.delivery_line_id
              WHERE sc.delivery_line_id IN (SELECT id FROM lines)
                AND sc.action = 'close'
                AND (sc.rtv_id IS NOT NULL OR sc.id > COALESCE(lr.id, 0))
              GROUP BY sc.delivery_line_id
           ),
           per_row AS (
             SELECT l.delivery_id,
                    sum(l.planned_qty * l.rate) AS planned_value,
                    sum((l.accepted_qty + l.rejected_qty) * l.rate) AS received_value,
                    sum(l.rejected_qty * l.rate) AS rejected_value,
                    sum(l.net * l.rate) AS net_value,
                    sum(COALESCE(c.vendor_sc, 0) * l.rate) AS vendor_sc_value,
                    sum(COALESCE(c.buyer_sc, 0) * l.rate) AS buyer_sc_value,
                    sum(COALESCE(c.vendor_sc, 0)) AS vendor_sc,
                    sum(COALESCE(c.buyer_sc, 0)) AS buyer_sc,
                    bool_and(l.net >= l.planned_qty) AS all_lines_full
               FROM lines l
               LEFT JOIN closed c ON c.delivery_line_id = l.id
              GROUP BY l.delivery_id
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
                  round(COALESCE(q.planned_value, 0), 4)::float8 AS planned_value,
                  round(COALESCE(q.received_value, 0), 4)::float8 AS received_value,
                  round(COALESCE(q.rejected_value, 0), 4)::float8 AS rejected_value,
                  round(COALESCE(q.net_value, 0), 4)::float8 AS net_value,
                  round(COALESCE(q.vendor_sc_value, 0), 4)::float8 AS vendor_sc_value,
                  round(COALESCE(q.buyer_sc_value, 0), 4)::float8 AS buyer_sc_value,
                  (COALESCE(q.buyer_sc, 0) > 0 AND COALESCE(q.vendor_sc, 0) = 0) AS buyer_closed,
                  (fr.first_at IS NOT NULL AND fr.first_at <= rd.due_date) AS on_time,
                  (COALESCE(q.all_lines_full, false) AND COALESCE(q.vendor_sc, 0) = 0) AS in_full
             FROM rows_due rd
             JOIN tbl_rfq_purchase_order po ON po.id = rd.po_id
             JOIN tbl_hospitality_company_hotels h ON h.id = rd.hotel_id
             LEFT JOIN per_row q ON q.delivery_id = rd.id
             LEFT JOIN first_receipt fr ON fr.delivery_id = rd.id
             LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
             LEFT JOIN tbl_company vc ON vc.id = v.company_id
            ORDER BY vendor_name, rd.due_date, po.po_number, rd.phase_no, rd.id`,
          [hotels, period.from, period.to, JUDGED_PO_STATUSES, VENDOR_SHORT_CLOSE_REASONS]
        )
      : [];

    const NOT_ASSESSED = "—";
    const deliveryRows = raw.map((r) => {
      const assessed = !r.buyer_closed;
      const onTime = assessed && !!r.on_time;
      const inFull = assessed && !!r.in_full;
      return {
        po_number: r.po_number || null,
        phase: Number(r.phase_no),
        hotel_name: r.hotel_name,
        vendor_id: r.vendor_id == null ? null : Number(r.vendor_id),
        vendor_name: r.vendor_name || "—",
        due_date: r.due_date,
        first_receipt: r.first_receipt || null,
        days_late: Number(r.days_late),
        planned_value: num(r.planned_value),
        received_value: num(r.received_value),
        rejected_value: num(r.rejected_value),
        net_value: num(r.net_value),
        vendor_short_closed_value: num(r.vendor_sc_value),
        buyer_short_closed_value: num(r.buyer_sc_value),
        assessed,
        on_time: onTime,
        in_full: inFull,
        otif: onTime && inFull,
        assessed_label: assessed ? "Yes" : "No — buyer short-close",
        on_time_label: assessed ? yesNo(onTime) : NOT_ASSESSED,
        in_full_label: assessed ? yesNo(inFull) : NOT_ASSESSED,
        otif_label: assessed ? yesNo(onTime && inFull) : NOT_ASSESSED,
      };
    });

    const byVendor = new Map();
    for (const d of deliveryRows) {
      const key = d.vendor_id ?? d.vendor_name;
      const v = byVendor.get(key) || {
        vendor_name: d.vendor_name,
        deliveries: 0,
        buyer_closed: 0,
        on_time: 0,
        in_full: 0,
        otif: 0,
        planned: 0,
        buyer_sc: 0,
        vendor_sc: 0,
        received: 0,
        rejected: 0,
        days_late: 0,
      };
      // Value-weighted rates run over every row in scope.
      v.planned = round4(v.planned + d.planned_value);
      v.buyer_sc = round4(v.buyer_sc + d.buyer_short_closed_value);
      v.vendor_sc = round4(v.vendor_sc + d.vendor_short_closed_value);
      v.received = round4(v.received + d.received_value);
      v.rejected = round4(v.rejected + d.rejected_value);
      // OTIF counts run over the assessed rows only.
      if (d.assessed) {
        v.deliveries += 1;
        v.on_time += d.on_time ? 1 : 0;
        v.in_full += d.in_full ? 1 : 0;
        v.otif += d.otif ? 1 : 0;
        v.days_late += d.days_late;
      } else {
        v.buyer_closed += 1;
      }
      byVendor.set(key, v);
    }
    const rows = [...byVendor.values()]
      .map((v) => ({
        vendor_name: v.vendor_name,
        deliveries: v.deliveries,
        buyer_closed: v.buyer_closed,
        on_time: v.on_time,
        in_full: v.in_full,
        otif: v.otif,
        on_time_pct: ratio(v.on_time, v.deliveries),
        in_full_pct: ratio(v.in_full, v.deliveries),
        otif_pct: ratio(v.otif, v.deliveries),
        rejection_pct: ratio(v.rejected, v.received),
        short_close_pct: ratio(v.vendor_sc, round4(v.planned - v.buyer_sc)),
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
      ["In scope", "Rows whose due date has passed, or already received or short-closed; legacy orders excluded"],
      ["Assessed", "Rows in scope except those short-closed for a buyer reason (counted under Buyer-closed)"],
      ["On time", "First receipt on or before the due date"],
      ["In full", "Every line's net accepted quantity reached plan, with nothing short-closed for a vendor reason"],
      ["Vendor reasons", "Vendor cannot supply, price dispute, and credit returns to vendor"],
      ["Buyer reasons", "No longer needed, substituted, other"],
      ["Rates", "Value-weighted (quantity × PO line rate) over every row in scope"],
    ];
    const ws = reportSheet(wb, "By Vendor", { footerTitle: "Vendor Delivery Performance" });
    writeReportSheet(ws, {
      title: "Vendor Delivery Performance",
      subtitle: `${rows.length} vendor(s) · ${deliveryRows.length} delivery row(s) in scope`,
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
      subtitle: "Every delivery row in scope · Values are quantity × PO line rate, summed over the row's lines",
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
