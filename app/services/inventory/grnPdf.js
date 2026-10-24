// GRN and RTV documents (spec §6.12–6.13).
//
// Two printable documents, rendered on demand from the posted rows (there is
// no stored pdf_url column; the same rows always give the same document):
//   - the goods receipt note: what arrived at the hotel against the PO, what
//     was accepted and rejected (with reasons), batches and expiries, and the
//     three signature blocks the stores team signs on paper;
//   - the RTV delivery challan the goods travel back to the vendor with: both
//     parties, HSN, qty, taxable value and GST, and the purpose (replacement or
//     credit note).
// Both carry a QR of the GRN short link (/s/g/<grnId>) with the URL printed
// under it, so a scan or a typed link lands on the receipt.
//
// Loading (load*Document) takes a transaction and returns a plain context the
// notices reuse; building (build*Html) is pure; rendering (render*Document)
// runs Chromium and uploads to S3, and is meant to run OUTSIDE any
// transaction so a render never holds a database connection.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import { pdfRenderer } from '../../util/pdfRenderer.js';
import { uploadToS3 } from '../../models/generalModel.js';
import { supplierDetailsFor } from '../../helper/gstState.js';
import { InventoryError } from './errors.js';
import { assertHotelPermission } from './scope.js';
import { resolvePoLineUnitCost } from './cost.js';
import { qrSvg } from './qr.js';
import { shortUrl } from './shortUrl.js';

export const REJECTION_LABELS = Object.freeze({
  damaged: 'Damaged',
  quality: 'Quality issue',
  wrong_item: 'Wrong item',
  short_shelf_life: 'Short shelf life',
  temperature: 'Temperature breach',
  excess: 'Excess quantity',
  other: 'Other',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (a DATE cast to text) → '31 Mar 2027'. Calendar dates have no zone. */
export function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A timestamp → '24 Oct 2026, 15:42 IST'. */
export function formatDateTimeIst(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(ist.getUTCDate())} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, `
    + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())} IST`;
}

/** 8 → '8', 2.5 → '2.5', 1.23456 → '1.2346'. */
export const formatQty = (n) => {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  return String(Math.round(Number(n) * 10000) / 10000);
};

/** 480 → '480.00', 120000 → '1,20,000.00'. */
export const formatMoney = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const num = (v) => (v == null ? null : Number(v));
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};
const round2 = (n) => Math.round(n * 100) / 100;
const slug = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';

// ─── Templates ──────────────────────────────────────────────────────────────

const hbs = Handlebars.create();
hbs.registerHelper('qty', (n) => formatQty(n));
hbs.registerHelper('money', (n) => formatMoney(n));
hbs.registerHelper('eq', (a, b) => a === b);

const compiled = new Map();
function template(name) {
  if (!compiled.has(name)) {
    const file = fileURLToPath(new URL(`../../templates/inventory/${name}`, import.meta.url));
    compiled.set(name, hbs.compile(fs.readFileSync(file, 'utf8'), { strict: false }));
  }
  return compiled.get(name);
}

// ─── Shared loaders ─────────────────────────────────────────────────────────

/** The receiving hotel as the documents print it. */
async function hotelParty(t, hotelId) {
  const h = await t.oneOrNone(
    `SELECT h.id, h.name, h.full_address, h.delivery_address, h.city, h.state, h.gst, c.name AS company_name
       FROM tbl_hospitality_company_hotels h
       LEFT JOIN tbl_hospitality_companies c ON c.id = h.hospitality_company_id
      WHERE h.id = $1`,
    [hotelId]
  );
  if (!h) return { name: null, companyName: null, address: null, gstin: null, state: null };
  return {
    name: clean(h.name),
    companyName: clean(h.company_name),
    address: clean(h.delivery_address) ?? clean(h.full_address) ?? clean(h.city),
    gstin: clean(h.gst)?.toUpperCase() ?? null,
    state: clean(h.state),
  };
}

/** The vendor as the documents print it (supplierDetailsFor, the PO PDF's source). */
async function vendorParty(t, vendorId) {
  const v = vendorId == null ? null : await supplierDetailsFor(Number(vendorId), t);
  return {
    id: vendorId == null ? null : Number(vendorId),
    name: v?.name ?? null,
    gstin: v?.gstin ?? null,
    address: v?.address ?? null,
    state: v?.state_name ?? null,
  };
}

// ─── GRN ────────────────────────────────────────────────────────────────────

/**
 * Everything the GRN document and the GRN notices need.
 * @returns {Promise<GrnDocument>} NOT_FOUND when the GRN does not exist.
 *
 * GrnDocument = { grnId, grnNumber, docType, status, title, companyId, hotelId,
 *   poId, poNumber, isCallOff, receivedAt, postedAt, vendorChallanNo,
 *   vendorChallanDate, vendorInvoiceNo, vendorInvoiceDate, ewayBillNo,
 *   vehicleNo, remarks, reversesGrnNumber, receivedByName, postedByName,
 *   postedBy, hotel, vendor, lines[], totals, qrUrl, qrSvg, generatedAt,
 *   recipients: {initiatorId, vendorId} }
 * line = { sn, grnLineId, poLineId, productName, hsn, unit, orderedForHotel,
 *   received, accepted, rejected, rejectionReason, rejectionLabel, batchNo,
 *   expiryDate, expiry, remarks }
 */
export async function loadGrnDocument(t, grnId) {
  const g = await t.oneOrNone(
    `SELECT g.id, g.grn_number, g.doc_type, g.status, g.hospitality_company_id, g.hotel_id, g.po_id,
            g.received_at::text AS received_at, g.posted_at, g.posted_by,
            g.vendor_challan_no, g.vendor_challan_date::text AS vendor_challan_date,
            g.vendor_invoice_no, g.vendor_invoice_date::text AS vendor_invoice_date,
            g.eway_bill_no, g.vehicle_no, g.remarks,
            rg.grn_number AS reverses_grn_number,
            po.po_number, po.finalized_vendor_id, po.is_call_off,
            COALESCE(po.initiated_by, mr.raised_by) AS initiator_id,
            COALESCE(ru.name, tk.name) AS received_by_name, pu.name AS posted_by_name
       FROM tbl_grn g
       JOIN tbl_rfq_purchase_order po ON po.id = g.po_id
       LEFT JOIN tbl_grn rg ON rg.id = g.reverses_grn_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
       LEFT JOIN tbl_users ru ON ru.id = g.received_by
       LEFT JOIN tbl_token_login_data tk ON tk.id = g.received_by_token_id
       LEFT JOIN tbl_users pu ON pu.id = g.posted_by
      WHERE g.id = $1`,
    [grnId]
  );
  if (!g) throw new InventoryError('NOT_FOUND', 'Goods receipt not found');

  const rows = await t.any(
    `SELECT gl.id, gl.po_line_id, gl.po_uom, gl.received_qty::text AS received, gl.accepted_qty::text AS accepted,
            gl.rejected_qty::text AS rejected, gl.rejection_reason, gl.batch_no,
            gl.expiry_date::text AS expiry_date, gl.remarks,
            COALESCE(pv.name, ii.display_name) AS product_name, pv.hsn_code,
            COALESCE(
              (SELECT SUM(dl.planned_qty)
                 FROM tbl_po_delivery_line dl JOIN tbl_po_delivery d ON d.id = dl.delivery_id
                WHERE dl.po_line_id = gl.po_line_id AND d.hotel_id = $2),
              pop.quantity
            )::text AS ordered_for_hotel
       FROM tbl_grn_line gl
       JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv
              ON pv.id = COALESCE(gl.product_variant_id, pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_inv_item ii ON ii.id = gl.inv_item_id
      WHERE gl.grn_id = $1
      ORDER BY gl.id`,
    [g.id, g.hotel_id]
  );

  const lines = rows.map((r, i) => ({
    sn: i + 1,
    grnLineId: Number(r.id),
    poLineId: Number(r.po_line_id),
    productName: r.product_name ?? null,
    hsn: clean(r.hsn_code),
    unit: r.po_uom ?? null,
    orderedForHotel: num(r.ordered_for_hotel),
    received: num(r.received),
    accepted: num(r.accepted),
    rejected: num(r.rejected),
    rejectionReason: r.rejection_reason ?? null,
    rejectionLabel: r.rejection_reason ? (REJECTION_LABELS[r.rejection_reason] ?? r.rejection_reason) : null,
    batchNo: r.batch_no ?? null,
    expiryDate: r.expiry_date ?? null,
    expiry: formatDate(r.expiry_date),
    remarks: r.remarks ?? null,
  }));
  const sum = (k) => Math.round(lines.reduce((s, l) => s + (l[k] || 0), 0) * 10000) / 10000;
  const qrUrl = shortUrl('g', Number(g.id));
  const isReversal = g.doc_type === 'REVERSAL';

  return {
    grnId: Number(g.id),
    grnNumber: g.grn_number ?? null,
    docType: g.doc_type,
    status: g.status,
    title: isReversal ? 'Goods Receipt Note (reversal)' : 'Goods Receipt Note',
    isReversal,
    companyId: Number(g.hospitality_company_id),
    hotelId: Number(g.hotel_id),
    poId: Number(g.po_id),
    poNumber: g.po_number ?? null,
    isCallOff: Boolean(g.is_call_off),
    receivedAt: formatDate(g.received_at),
    postedAt: formatDateTimeIst(g.posted_at),
    postedBy: g.posted_by == null ? null : Number(g.posted_by),
    vendorChallanNo: g.vendor_challan_no ?? null,
    vendorChallanDate: formatDate(g.vendor_challan_date),
    vendorInvoiceNo: g.vendor_invoice_no ?? null,
    vendorInvoiceDate: formatDate(g.vendor_invoice_date),
    ewayBillNo: g.eway_bill_no ?? null,
    vehicleNo: g.vehicle_no ?? null,
    remarks: g.remarks ?? null,
    reversesGrnNumber: g.reverses_grn_number ?? null,
    receivedByName: g.received_by_name ?? null,
    postedByName: g.posted_by_name ?? null,
    hotel: await hotelParty(t, g.hotel_id),
    vendor: await vendorParty(t, g.finalized_vendor_id),
    lines,
    totals: { received: sum('received'), accepted: sum('accepted'), rejected: sum('rejected') },
    hasRejections: lines.some((l) => (l.rejected || 0) > 0),
    qrUrl,
    qrSvg: qrSvg(qrUrl),
    generatedAt: formatDateTimeIst(new Date()),
    recipients: {
      initiatorId: g.initiator_id == null ? null : Number(g.initiator_id),
      vendorId: g.finalized_vendor_id == null ? null : Number(g.finalized_vendor_id),
    },
  };
}

/** The GRN as self-contained HTML (inline CSS, inline SVG QR, no scripts). */
export const buildGrnHtml = (ctx) => template('grn.html')(ctx);

/**
 * May this user download this GRN's document? grn.read at its hotel; a GRN in
 * another company reads as not found; a draft has no document yet.
 * @throws InventoryError NOT_FOUND | FORBIDDEN | CONFLICT
 */
export async function assertGrnDocumentAccess(t, user, grnId) {
  const id = Number(grnId);
  const notFound = () => new InventoryError('NOT_FOUND', 'Goods receipt not found');
  const g = Number.isInteger(id) && id > 0
    ? await t.oneOrNone(`SELECT id, hospitality_company_id, hotel_id, status FROM tbl_grn WHERE id = $1`, [id])
    : null;
  if (!g) throw notFound();
  let companyId;
  try {
    ({ companyId } = await assertHotelPermission(t, user, { resource: 'grn', action: 'read', hotelId: g.hotel_id }));
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw notFound();
    throw err;
  }
  if (Number(g.hospitality_company_id) !== companyId) throw notFound();
  if (g.status === 'draft') {
    throw new InventoryError('CONFLICT', 'A draft goods receipt has no document yet', { grnId: id, status: g.status });
  }
}

/** Render HTML to a PDF and upload it; returns the S3 URL. Outside any transaction. */
async function renderAndUpload(html, key) {
  const tmpPath = path.join(os.tmpdir(), `${slug(key)}-${process.pid}-${Date.now()}.pdf`);
  try {
    await pdfRenderer.renderToFile(html, tmpPath);
    const up = await uploadToS3(tmpPath, key);
    if (!up?.ok || !up.url) throw new Error(`PDF upload failed for ${key}: ${up?.error ?? 'no URL'}`);
    return up.url;
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
  }
}

/** Render a loaded GRN document; returns its URL. */
export const renderGrnDocument = (ctx) =>
  renderAndUpload(buildGrnHtml(ctx), `grn/${ctx.companyId}/${ctx.grnId}-${slug(ctx.grnNumber)}.pdf`);

/** Load + render (convenience; holds `t` while rendering, so prefer the split in request paths). */
export async function renderGrnPdf(t, grnId) {
  return renderGrnDocument(await loadGrnDocument(t, grnId));
}

// ─── RTV ────────────────────────────────────────────────────────────────────

/**
 * Everything the RTV challan and the RTV notice need.
 * RtvDocument = { rtvId, rtvNumber, disposition, purpose, status, challanNo,
 *   creditNoteRef, remarks, dispatchedAt, companyId, hotelId, poId, poNumber,
 *   grnId, grnNumber, consignor, consignee, lines[], totals, qrUrl, qrSvg,
 *   generatedAt, recipients: {initiatorId, vendorId} }
 * line = { sn, rtvLineId, grnLineId, poLineId, productName, hsn, unit, qty,
 *   rate, taxable, gstPct, gst, reason, batchNo, expiry }
 */
export async function loadRtvDocument(t, rtvId) {
  const r = await t.oneOrNone(
    `SELECT r.id, r.rtv_number, r.disposition, r.status, r.challan_no, r.credit_note_ref, r.remarks,
            r.hospitality_company_id, r.hotel_id, r.po_id, r.grn_id, r.created_at, r.updated_at,
            g.grn_number, g.received_at::text AS grn_received_at,
            po.po_number, po.finalized_vendor_id, COALESCE(po.initiated_by, mr.raised_by) AS initiator_id
       FROM tbl_rtv r
       JOIN tbl_grn g ON g.id = r.grn_id
       JOIN tbl_rfq_purchase_order po ON po.id = r.po_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE r.id = $1`,
    [rtvId]
  );
  if (!r) throw new InventoryError('NOT_FOUND', 'Return to vendor not found');

  const rows = await t.any(
    `SELECT rl.id, rl.grn_line_id, rl.qty::text AS qty, rl.reason, gl.po_line_id, gl.po_uom, gl.batch_no,
            gl.expiry_date::text AS expiry_date, COALESCE(pv.name, ii.display_name) AS product_name, pv.hsn_code
       FROM tbl_rtv_line rl
       JOIN tbl_grn_line gl ON gl.id = rl.grn_line_id
       JOIN tbl_purchase_order_product pop ON pop.id = gl.po_line_id
       LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       LEFT JOIN tbl_product_variant pv
              ON pv.id = COALESCE(gl.product_variant_id, pop.product_variant_id, rp.product_variant_id)
       LEFT JOIN tbl_inv_item ii ON ii.id = gl.inv_item_id
      WHERE rl.rtv_id = $1
      ORDER BY rl.id`,
    [r.id]
  );

  const companyId = Number(r.hospitality_company_id);
  const hotelId = Number(r.hotel_id);
  const lines = [];
  for (const [i, row] of rows.entries()) {
    // The PO's taxable rate per PO unit, the same figure the PO was priced at.
    const { taxableUnitRate, gstPct } = await resolvePoLineUnitCost(t, {
      poLineId: Number(row.po_line_id), hotelId, companyId,
    });
    const qty = Number(row.qty);
    const taxable = round2(qty * taxableUnitRate);
    lines.push({
      sn: i + 1,
      rtvLineId: Number(row.id),
      grnLineId: Number(row.grn_line_id),
      poLineId: Number(row.po_line_id),
      productName: row.product_name ?? null,
      hsn: clean(row.hsn_code),
      unit: row.po_uom ?? null,
      qty,
      rate: taxableUnitRate,
      taxable,
      gstPct,
      gst: round2(taxable * (gstPct / 100)),
      reason: row.reason ?? null,
      batchNo: row.batch_no ?? null,
      expiry: formatDate(row.expiry_date),
    });
  }
  const taxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst, 0));
  const qrUrl = shortUrl('g', Number(r.grn_id));

  return {
    rtvId: Number(r.id),
    rtvNumber: r.rtv_number ?? null,
    disposition: r.disposition,
    purpose: r.disposition === 'CREDIT' ? 'Against credit note' : 'For replacement',
    status: r.status,
    challanNo: r.challan_no ?? null,
    creditNoteRef: r.credit_note_ref ?? null,
    remarks: r.remarks ?? null,
    dispatchedAt: r.status === 'draft' ? null : formatDateTimeIst(r.updated_at),
    companyId,
    hotelId,
    poId: Number(r.po_id),
    poNumber: r.po_number ?? null,
    grnId: Number(r.grn_id),
    grnNumber: r.grn_number ?? null,
    grnReceivedAt: formatDate(r.grn_received_at),
    consignor: await hotelParty(t, hotelId),
    consignee: await vendorParty(t, r.finalized_vendor_id),
    lines,
    totals: { taxable, gst, total: round2(taxable + gst) },
    qrUrl,
    qrSvg: qrSvg(qrUrl),
    generatedAt: formatDateTimeIst(new Date()),
    recipients: {
      initiatorId: r.initiator_id == null ? null : Number(r.initiator_id),
      vendorId: r.finalized_vendor_id == null ? null : Number(r.finalized_vendor_id),
    },
  };
}

/** The RTV delivery challan as self-contained HTML. */
export const buildRtvHtml = (ctx) => template('rtv.html')(ctx);

/** Render a loaded RTV document; returns its URL. Drafts have no number, so no challan. */
export const renderRtvDocument = (ctx) =>
  renderAndUpload(buildRtvHtml(ctx), `rtv/${ctx.companyId}/${ctx.rtvId}-${slug(ctx.rtvNumber)}.pdf`);

export async function renderRtvPdf(t, rtvId) {
  return renderRtvDocument(await loadRtvDocument(t, rtvId));
}

export default {
  loadGrnDocument, buildGrnHtml, renderGrnDocument, renderGrnPdf, assertGrnDocumentAccess,
  loadRtvDocument, buildRtvHtml, renderRtvDocument, renderRtvPdf, REJECTION_LABELS,
};
