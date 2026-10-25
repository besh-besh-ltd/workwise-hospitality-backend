// ============================================================================
// 8.1 — GRN Register
// ----------------------------------------------------------------------------
// Every goods receipt (and receipt reversal) posted in the period at the
// hotels where the caller can read GRNs, by receipt date, with its value and
// how many lines carried a rejection; then every line.
//
// The value is the stock value the GRN posted: Σ of its GRN_IN / GRN_REVERSAL
// movements (a mark-out on arrival is consumption, not receipt). Drafts never
// posted and are left out.
// ============================================================================

import { FMT, istDateLabel, reportSheet, writeReportSheet } from "../excelKit.js";
import db from "../../../config/dbConn.js";
import { REPORT_ROW_CAP } from "../../../models/reportsModel.js";
import {
  QTY_FMT,
  RECEIVING_FAMILY,
  REJECTION_REASON_LABELS,
  VENDOR_NAME,
  hotelNames,
  hotelsLabel,
  num,
  periodLabel,
  previewColumns,
  reportHotels,
  xlDay,
} from "../inventoryReportKit.js";

const TYPE_LABELS = { RECEIPT: "Receipt", REVERSAL: "Reversal" };
const STATUS_LABELS = { posted: "Posted", reversed: "Reversed", partially_reversed: "Partly reversed" };

const COLUMNS = [
  { header: "Received", key: "received_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "GRN Number", key: "grn_number", width: 24, type: "text" },
  { header: "Type", key: "type", width: 10, type: "text" },
  { header: "Status", key: "status", width: 15, type: "text" },
  { header: "Hotel", key: "hotel_name", width: 24, type: "text" },
  { header: "PO Number", key: "po_number", width: 22, type: "text" },
  { header: "Vendor", key: "vendor_name", width: 28, type: "text" },
  { header: "Challan No", key: "vendor_challan_no", width: 14, type: "text" },
  { header: "Invoice No", key: "vendor_invoice_no", width: 14, type: "text" },
  { header: "Lines", key: "line_count", width: 8, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Lines Rejected", key: "rejected_lines", width: 10, align: "right", numFmt: FMT.INT, type: "int", total: "sum" },
  { header: "Value (₹)", key: "value", width: 15, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Reverses", key: "reverses_grn_number", width: 24, type: "text" },
  { header: "Received By", key: "received_by_name", width: 22, type: "text" },
];

const LINE_COLUMNS = [
  { header: "GRN Number", key: "grn_number", width: 24, type: "text" },
  { header: "Date", key: "received_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
  { header: "Hotel", key: "hotel_name", width: 22, type: "text" },
  { header: "PO Number", key: "po_number", width: 22, type: "text" },
  { header: "Item", key: "item_name", width: 30, type: "text" },
  { header: "PO Unit", key: "po_uom", width: 9, type: "text" },
  { header: "Received", key: "received_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Accepted", key: "accepted_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Rejected", key: "rejected_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Rejection Reason", key: "rejection_reason", width: 16, type: "text" },
  { header: "Stock Qty", key: "stock_qty", width: 11, align: "right", numFmt: QTY_FMT, type: "int" },
  { header: "Stock Unit", key: "stock_uom", width: 9, type: "text" },
  { header: "Unit Cost (₹)", key: "unit_cost", width: 13, align: "right", numFmt: FMT.INR_2, type: "money" },
  { header: "Value (₹)", key: "value", width: 14, align: "right", numFmt: FMT.INR, type: "money", total: "sum" },
  { header: "Batch", key: "batch_no", width: 12, type: "text" },
  { header: "Expiry", key: "expiry_date", width: 13, align: "center", numFmt: FMT.DATE, type: "date" },
];

export default {
  key: "grn_register",
  number: "8.1",
  family: RECEIVING_FAMILY,
  title: "GRN Register",
  description: "Every goods receipt posted in the period, with its value and rejections, and every line.",
  permission: "reports.grn_register",
  readiness: { state: "ready" },
  filters: [
    { key: "fy", type: "fy", label: "Financial year" },
    { key: "hotel_ids", type: "hotels", label: "Business unit" },
  ],

  async fetch(scope, period) {
    const hotels = await reportHotels(scope, "grn");
    const grns = hotels.length
      ? await db.any(
          `SELECT g.id, g.grn_number, g.doc_type, g.status, g.received_at::text AS received_date,
                  h.name AS hotel_name, po.po_number, ${VENDOR_NAME} AS vendor_name,
                  g.vendor_challan_no, g.vendor_invoice_no, rg.grn_number AS reverses_grn_number,
                  COALESCE(ru.name, tk.name) AS received_by_name,
                  (SELECT count(*) FROM tbl_grn_line gl WHERE gl.grn_id = g.id)::int AS line_count,
                  (SELECT count(*) FROM tbl_grn_line gl WHERE gl.grn_id = g.id AND gl.rejected_qty > 0)::int
                    AS rejected_lines,
                  (SELECT COALESCE(sum(m.value), 0) FROM tbl_inv_movement m
                    WHERE m.source_type = 'GRN' AND m.source_id = g.id
                      AND m.hospitality_company_id = g.hospitality_company_id
                      AND m.movement_type IN ('GRN_IN', 'GRN_REVERSAL'))::float8 AS value
             FROM tbl_grn g
             JOIN tbl_hospitality_company_hotels h ON h.id = g.hotel_id
             JOIN tbl_rfq_purchase_order po ON po.id = g.po_id
             LEFT JOIN tbl_users v ON v.id = po.finalized_vendor_id
             LEFT JOIN tbl_company vc ON vc.id = v.company_id
             LEFT JOIN tbl_grn rg ON rg.id = g.reverses_grn_id
             LEFT JOIN tbl_users ru ON ru.id = g.received_by
             LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id
            WHERE g.hotel_id = ANY($1::int[])
              AND g.status <> 'draft'
              AND g.received_at >= $2::date
              AND g.received_at <  $3::date
            ORDER BY g.received_at, g.id
            LIMIT $4`,
          [hotels, period.from, period.to, REPORT_ROW_CAP]
        )
      : [];
    const grnIds = grns.map((g) => Number(g.id));

    const lines = grnIds.length
      ? await db.any(
          `SELECT gl.grn_id, COALESCE(pv.name, ii.display_name) AS item_name, gl.po_uom,
                  gl.received_qty::float8 AS received_qty, gl.accepted_qty::float8 AS accepted_qty,
                  gl.rejected_qty::float8 AS rejected_qty, gl.rejection_reason,
                  gl.stock_qty::float8 AS stock_qty, ii.stock_uom, gl.unit_cost::float8 AS unit_cost,
                  gl.batch_no, gl.expiry_date::text AS expiry_date,
                  (SELECT COALESCE(sum(m.value), 0) FROM tbl_inv_movement m
                    WHERE m.source_type = 'GRN' AND m.source_id = gl.grn_id AND m.source_line_id = gl.id
                      AND m.hospitality_company_id = gl.hospitality_company_id
                      AND m.movement_type IN ('GRN_IN', 'GRN_REVERSAL'))::float8 AS value
             FROM tbl_grn_line gl
             JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
             LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
             LEFT JOIN tbl_product_variant pv
                    ON pv.id = COALESCE(gl.product_variant_id, pop.product_variant_id, rp.product_variant_id)
             LEFT JOIN tbl_inv_item ii ON ii.id = gl.inv_item_id
            WHERE gl.grn_id = ANY($1::int[])
            ORDER BY gl.grn_id, gl.id`,
          [grnIds]
        )
      : [];

    const rows = grns.map((g) => ({
      received_date: g.received_date,
      grn_number: g.grn_number || null,
      type: TYPE_LABELS[g.doc_type] || g.doc_type,
      status: STATUS_LABELS[g.status] || g.status,
      hotel_name: g.hotel_name,
      po_number: g.po_number || null,
      vendor_name: g.vendor_name || null,
      vendor_challan_no: g.vendor_challan_no || null,
      vendor_invoice_no: g.vendor_invoice_no || null,
      line_count: Number(g.line_count) || 0,
      rejected_lines: Number(g.rejected_lines) || 0,
      value: num(g.value),
      reverses_grn_number: g.reverses_grn_number || null,
      received_by_name: g.received_by_name || null,
    }));

    const byId = new Map(grns.map((g, idx) => [Number(g.id), rows[idx]]));
    const lineRows = lines.map((l) => {
      const g = byId.get(Number(l.grn_id));
      return {
        grn_number: g.grn_number,
        received_date: g.received_date,
        hotel_name: g.hotel_name,
        po_number: g.po_number,
        item_name: l.item_name || null,
        po_uom: l.po_uom,
        received_qty: num(l.received_qty),
        accepted_qty: num(l.accepted_qty),
        rejected_qty: num(l.rejected_qty),
        rejection_reason: l.rejection_reason ? REJECTION_REASON_LABELS[l.rejection_reason] || l.rejection_reason : null,
        stock_qty: num(l.stock_qty),
        stock_uom: l.stock_uom || null,
        unit_cost: num(l.unit_cost),
        value: num(l.value),
        batch_no: l.batch_no || null,
        expiry_date: l.expiry_date || null,
      };
    });

    return { rows, lineRows, period, hotelNames: await hotelNames(hotels) };
  },

  preview({ rows }) {
    return { columns: previewColumns(COLUMNS), rows };
  },

  buildWorkbook(wb, { rows, lineRows, period, hotelNames: names }, { generatedBy }) {
    const asOf = istDateLabel(new Date());
    const params = [
      ["Period", `${periodLabel(period)} (by receipt date)`],
      ["Business units", hotelsLabel(names)],
      ["Value", "Stock value posted by the GRN; a reversal is negative"],
    ];
    const ws = reportSheet(wb, "GRN Register", { footerTitle: "GRN Register" });
    writeReportSheet(ws, {
      title: "GRN Register",
      subtitle: `${rows.length} GRN(s) · By receipt date · All amounts in ₹`,
      params,
      columns: COLUMNS,
      rows: rows.map((r) => ({ ...r, received_date: xlDay(r.received_date) })),
      totalLabel: "Total",
      freezeCols: 2,
      generatedBy,
      asOf,
    });

    const ws2 = reportSheet(wb, "GRN Lines", { footerTitle: "GRN Register — lines" });
    writeReportSheet(ws2, {
      title: "GRN Lines",
      subtitle: "Every line of the GRNs above · Received, accepted and rejected in the PO unit",
      params,
      columns: LINE_COLUMNS,
      rows: lineRows.map((r) => ({ ...r, received_date: xlDay(r.received_date), expiry_date: xlDay(r.expiry_date) })),
      totalLabel: "Total",
      freezeCols: 1,
      generatedBy,
      asOf,
    });
    return wb;
  },
};
