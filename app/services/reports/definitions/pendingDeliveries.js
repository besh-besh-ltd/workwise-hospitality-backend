// ============================================================================
// 8.2 — Pending Deliveries
// ----------------------------------------------------------------------------
// Every delivery-plan line still waiting for goods, at the hotels where the
// caller can read GRNs, as of today: what is open, when it was due and how
// many days overdue it is. Soonest due first; unscheduled rows last.
//
// Which rows (the same set the Overview counts):
//   - the delivery row is open or partial and has a hotel (an unallocated
//     row on a multi-hotel PO belongs to no hotel);
//   - the line still has quantity open: planned − net accepted − short-closed;
//   - the PO is live and receivable (approved, dispatched, GRN, invoice
//     raised), not fully received or closed short, and not a legacy order
//     from before receiving went live (spec §13).
// The period filter does not apply: pending is "as of today".
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
  istDay,
  num,
  previewColumns,
  reportHotels,
  xlDay,
} from "../inventoryReportKit.js";

const COLUMNS = [
  { header: "Hotel", key: "hotel_name", width: 22, type: "text" },
  { header: "PO Number", key: "po_number", width: 22, type: "text" },
  { header: "Vendor", key: "vendor_name", width: 28, type: "text" },
  { header: "Phase", key: "phase", width: 7, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Due Date", key: "due_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Due Status", key: "due_status", width: 12, type: "text" },
  { header: "Days Overdue", key: "days_overdue", width: 12, align: "right", numFmt: FMT.INT, type: "int" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "PO Unit", key: "po_uom", width: 9, type: "text" },
  { header: "Planned", key: "planned_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Net Received", key: "received_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Short-closed", key: "short_closed_qty", width: 12, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Open", key: "open_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "PO Date", key: "po_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "PO Age (days)", key: "po_age_days", width: 12, align: "right", numFmt: FMT.INT, type: "int" },
];

const dueStatus = (dueDate, days) => {
  if (!dueDate) return "Unscheduled";
  if (days > 0) return "Overdue";
  if (days === 0) return "Due today";
  return "Upcoming";
};

export default {
  key: "pending_deliveries",
  number: "8.2",
  family: RECEIVING_FAMILY,
  title: "Pending Deliveries",
  description: "Open delivery-plan lines still awaiting goods, with how many days each is overdue, as of today.",
  permission: "reports.pending_deliveries",
  readiness: { state: "ready" },
  filters: [{ key: "hotel_ids", type: "hotels", label: "Business unit" }],

  async fetch(scope) {
    const hotels = await reportHotels(scope, "grn");
    const raw = hotels.length
      ? await db.any(
          `WITH open_lines AS (
             SELECT d.hotel_id, d.po_id, d.phase_no, d.due_date, dl.po_line_id,
                    dl.planned_qty,
                    dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty AS net_qty,
                    dl.short_closed_qty,
                    GREATEST(dl.planned_qty - (dl.accepted_qty - dl.returned_replace_qty - dl.returned_credit_qty)
                             - dl.short_closed_qty, 0) AS open_qty,
                    dl.id AS delivery_line_id
               FROM tbl_po_delivery d
               JOIN tbl_po_delivery_line dl ON dl.delivery_id = d.id
              WHERE d.hotel_id = ANY($1::int[])
                AND d.status IN ('open', 'partial')
           )
           SELECT h.name AS hotel_name, po.po_number, ${VENDOR_NAME} AS vendor_name, ol.phase_no,
                  ol.due_date::text AS due_date, (${IST_TODAY} - ol.due_date) AS days_past_due,
                  COALESCE(pv.name, ii.display_name) AS item_name, pop.unit AS po_uom,
                  ol.planned_qty::float8 AS planned_qty, ol.net_qty::float8 AS received_qty,
                  ol.short_closed_qty::float8 AS short_closed_qty, ol.open_qty::float8 AS open_qty,
                  ${istDay("po.created_at")} AS po_date,
                  (${IST_TODAY} - (po.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS po_age_days
             FROM open_lines ol
             JOIN tbl_rfq_purchase_order po ON po.id = ol.po_id
             JOIN tbl_hospitality_company_hotels h ON h.id = ol.hotel_id
             JOIN tbl_purchase_order_product pop ON pop.id = ol.po_line_id
             LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
             LEFT JOIN tbl_product_variant pv ON pv.id = COALESCE(pop.product_variant_id, rp.product_variant_id)
             LEFT JOIN tbl_inv_item_variant iv
                    ON iv.product_variant_id = pv.id AND iv.hospitality_company_id = h.hospitality_company_id
             LEFT JOIN tbl_inv_item ii ON ii.id = iv.inv_item_id
             LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
             LEFT JOIN tbl_company vc ON vc.id = v.company_id
            WHERE ol.open_qty > 0
              AND NOT po.receipt_legacy
              AND po.status::text = ANY($2::text[])
              AND po.receipt_status NOT IN ('received', 'closed_short')
            ORDER BY ol.due_date ASC NULLS LAST, h.name, po.po_number, ol.phase_no, ol.delivery_line_id`,
          [hotels, RECEIVABLE_PO_STATUSES]
        )
      : [];

    const rows = raw.map((r) => {
      const past = r.days_past_due == null ? null : Number(r.days_past_due);
      return {
        hotel_name: r.hotel_name,
        po_number: r.po_number || null,
        vendor_name: r.vendor_name || null,
        phase: Number(r.phase_no),
        due_date: r.due_date || null,
        due_status: dueStatus(r.due_date, past),
        days_overdue: past !== null && past > 0 ? past : null,
        item_name: r.item_name || null,
        po_uom: r.po_uom || null,
        planned_qty: num(r.planned_qty),
        received_qty: num(r.received_qty),
        short_closed_qty: num(r.short_closed_qty),
        open_qty: num(r.open_qty),
        po_date: r.po_date || null,
        po_age_days: num(r.po_age_days),
      };
    });

    return { rows, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const overdue = rows.filter((r) => r.due_status === "Overdue").length;
    const ws = reportSheet(wb, "Pending Deliveries", { footerTitle: "Pending Deliveries" });
    writeReportSheet(ws, {
      title: "Pending Deliveries",
      subtitle: `${rows.length} open line(s), ${overdue} overdue · Soonest due first · Quantities in the PO unit`,
      params: [
        ["As of", asOf],
        ["Business units", hotelsLabel(names)],
        ["Open", "Planned less net accepted and short-closed"],
        ["Excluded", "Legacy orders from before receiving went live, and rows not yet allocated to a hotel"],
      ],
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, due_date: xlDay(r.due_date), po_date: xlDay(r.po_date) })),
      freezeCols: 2,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
