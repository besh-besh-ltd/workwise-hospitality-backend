// Item label sheets (spec §10.1).
//
// A label carries our QR (the item's short link, shortUrl('i', id), so a plain
// phone camera opens the item too), the item name, item code, stock unit and
// the bin at the chosen hotel, plus batch and expiry when given or printed from
// a GRN. Layouts: A4 65-up (38.1×21.2 mm), A4 24-up (63.5×33.9 mm) and a
// 50×25 mm thermal roll, one label per page, printed through the normal driver.
//
// Rendering follows the PO PDF: Handlebars HTML (app/templates/inventory/
// labels.html) → the shared Chromium (pdfRenderer.renderToFile, to a temp
// file) → uploadToS3 → public URL. The data is read first; the render and the
// upload run after the reads, so a caller passing `db` holds no connection
// while Chromium works. Nothing is written to the database.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import { InventoryError } from './errors.js';
import { assertHotelPermission, hotelIdsWithPermission } from './scope.js';
import { qrSvg } from './qr.js';
import { shortUrl } from './shortUrl.js';
import { pdfRenderer, NO_MARGIN } from '../../util/pdfRenderer.js';
import { uploadToS3 } from '../../models/generalModel.js';

/** Labels per request, across every item and copy. */
export const MAX_LABELS = 1000;
const MAX_ITEMS = 200;

const A4 = { pageSize: 'A4', pageWidth: '210mm', pageHeight: '297mm' };
const A4_PDF = { format: 'A4', margin: NO_MARGIN, preferCSSPageSize: true };

/**
 * Sheet geometry. A4 sheets follow the common 65-up (L7651) and 24-up (L7159)
 * stock; every value is a CSS length dropped into the template.
 */
export const LABEL_LAYOUTS = Object.freeze({
  A4_65: Object.freeze({
    ...A4, cols: 5, rows: 13, labelWidth: '38.1mm', labelHeight: '21.2mm',
    marginTop: '10.7mm', marginLeft: '4.75mm', colGap: '2.5mm', rowGap: '0mm',
    padding: '0.6mm 1.2mm 0.6mm 0.6mm', gap: '0.6mm', qrSize: '17mm', qrQuiet: '1.5mm', fontSize: '5.6pt', nameLines: 2,
    pdf: A4_PDF,
  }),
  A4_24: Object.freeze({
    ...A4, cols: 3, rows: 8, labelWidth: '63.5mm', labelHeight: '33.9mm',
    marginTop: '12.9mm', marginLeft: '7.25mm', colGap: '2.5mm', rowGap: '0mm',
    padding: '1.2mm 2mm 1.2mm 1.2mm', gap: '1mm', qrSize: '27mm', qrQuiet: '2.2mm', fontSize: '7.5pt', nameLines: 3,
    pdf: A4_PDF,
  }),
  THERMAL_50x25: Object.freeze({
    pageSize: '50mm 25mm', pageWidth: '50mm', pageHeight: '25mm',
    cols: 1, rows: 1, labelWidth: '50mm', labelHeight: '25mm',
    marginTop: '0mm', marginLeft: '0mm', colGap: '0mm', rowGap: '0mm',
    padding: '1mm 1.5mm 1mm 0.8mm', gap: '0.6mm', qrSize: '21mm', qrQuiet: '1.6mm', fontSize: '7pt', nameLines: 2,
    // format must be unset, or puppeteer ignores width/height.
    pdf: { format: undefined, width: '50mm', height: '25mm', margin: NO_MARGIN, preferCSSPageSize: true },
  }),
});

export const GRN_LABEL_MODES = ['per_unit', 'per_pack'];

const TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../templates/inventory/labels.html'
);
const hbs = Handlebars.create();
let compiled = null;
const template = () => {
  if (!compiled) compiled = hbs.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  return compiled;
};

const positiveInt = (v) => {
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const invalid = (field, message, details = {}) =>
  new InventoryError('VALIDATION', message, { field, ...details });

// One message whether the id is missing or belongs to another company, so the
// label endpoints cannot be used to probe which ids exist.
const itemNotFound = () => new InventoryError('NOT_FOUND', 'Item not found');
const grnNotFound = () => new InventoryError('NOT_FOUND', 'GRN not found');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' that names a real day, else null. */
function isoDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** '2027-03-31' → '31 Mar 2027' (unambiguous on a shelf). */
const displayDate = (v) => {
  const day = isoDay(v);
  if (!day) return null;
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

function layoutOf(layout) {
  const spec = typeof layout === 'string' ? LABEL_LAYOUTS[layout] : null;
  if (!spec) {
    throw invalid('layout', `Choose a label layout: ${Object.keys(LABEL_LAYOUTS).join(', ')}`);
  }
  return spec;
}

/** Stock-unit or pack count to a whole number of labels, at least one. */
const labelCount = (qty) => Math.max(1, Math.ceil(Number(qty) - 1e-9));

/**
 * An item's QR as an SVG <symbol> body: bwip-js returns one <svg viewBox> per
 * code; the sheet defines it once and every label of the item <use>s it, so a
 * 1000-label job carries one drawing per item, not one per label (~4 KB each).
 */
function qrSymbol(invItemId) {
  const svg = qrSvg(shortUrl('i', invItemId));
  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  const open = svg.indexOf('>');
  const close = svg.lastIndexOf('</svg>');
  if (!viewBox || open === -1 || close === -1) throw new Error('unexpected QR SVG from bwip-js');
  return { id: `qr-i-${invItemId}`, viewBox, body: svg.slice(open + 1, close).trim() };
}

/**
 * The label sheet HTML (the template function). Pure: no database, no I/O
 * beyond the cached template file.
 *
 * @param {{layout:'A4_65'|'A4_24'|'THERMAL_50x25', labels:Array<{invItemId:number,
 *   name:string, itemCode?:string|null, stockUom:string, binLabel?:string|null,
 *   batchNo?:string|null, expiryDate?:'YYYY-MM-DD'|null}>}} args
 *   one entry per printed label (copies already expanded)
 * @returns {string} HTML
 */
export function renderLabelsHtml({ layout, labels }) {
  const spec = layoutOf(layout);
  const symbols = new Map();
  const qrFor = (id) => {
    if (!symbols.has(id)) symbols.set(id, qrSymbol(id));
    return symbols.get(id);
  };
  const rows = (labels || []).map((l) => ({
    qr: qrFor(l.invItemId),
    name: l.name,
    itemCode: l.itemCode || null,
    stockUom: l.stockUom,
    binLabel: l.binLabel || null,
    batchNo: l.batchNo || null,
    expiry: displayDate(l.expiryDate),
  }));
  const perSheet = spec.cols * spec.rows;
  const sheets = [];
  for (let i = 0; i < rows.length; i += perSheet) sheets.push({ labels: rows.slice(i, i + perSheet) });
  return template()({ layout: spec, sheets, symbols: [...symbols.values()] });
}

/** Render to a temp PDF, upload, clean up. Throws when the upload fails. */
async function renderAndUpload({ layout, labels, companyId, name }) {
  const html = renderLabelsHtml({ layout, labels });
  const file = path.join(
    os.tmpdir(),
    `inv-labels-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`
  );
  try {
    await pdfRenderer.renderToFile(html, file, LABEL_LAYOUTS[layout].pdf);
    const safeName = String(name).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);
    const key = `inventory/labels/${companyId}/${safeName}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.pdf`;
    const up = await uploadToS3(file, key);
    if (!up?.ok || !up.url) throw new Error(`label PDF upload failed: ${up?.error || 'no url'}`);
    return { url: up.url };
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

function assertTotal(total) {
  if (total > MAX_LABELS) {
    throw invalid('copies', `That is ${total} labels; print at most ${MAX_LABELS} at a time`, {
      total,
      max: MAX_LABELS,
    });
  }
}

/**
 * inventory.update somewhere in the company. When the user holds it at no
 * hotel there, the refusal comes from assertHotelPermission on one of the
 * company's hotels: FORBIDDEN for a member of the company, NOT_FOUND otherwise.
 */
async function assertUpdateInCompany(t, user, companyId) {
  const hotels = await hotelIdsWithPermission(t, user, 'inventory', 'update');
  const live = await t.any(
    `SELECT id FROM tbl_hospitality_company_hotels
      WHERE hospitality_company_id = $1 AND COALESCE(is_deleted, 0) = 0 ORDER BY id`,
    [companyId]
  );
  if (live.some((h) => hotels.includes(Number(h.id)))) return;
  if (!live.length) throw itemNotFound();
  try {
    await assertHotelPermission(t, user, { resource: 'inventory', action: 'update', hotelId: Number(live[0].id) });
  } catch (err) {
    // Outside the company: the same answer as for an id that does not exist.
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw itemNotFound();
    throw err;
  }
  // A super admin passes above; anyone reaching here holds no grant.
  throw itemNotFound();
}

function validateItemsPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  layoutOf(p.layout);
  let hotelId = null;
  if (p.hotelId != null && p.hotelId !== '') {
    hotelId = positiveInt(p.hotelId);
    if (!hotelId) throw invalid('hotelId', 'Invalid hotel');
  }
  if (!Array.isArray(p.items) || p.items.length === 0) throw invalid('items', 'Pick at least one item');
  if (p.items.length > MAX_ITEMS) throw invalid('items', `Pick at most ${MAX_ITEMS} items at a time`);

  let total = 0;
  const items = p.items.map((raw, index) => {
    const it = raw && typeof raw === 'object' ? raw : {};
    const invItemId = positiveInt(it.invItemId);
    if (!invItemId) throw invalid('invItemId', 'Invalid item', { index });
    const copies = it.copies == null ? 1 : Number(it.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_LABELS) {
      throw invalid('copies', `Copies must be a whole number from 1 to ${MAX_LABELS}`, { index });
    }
    let batchNo = null;
    if (it.batchNo != null && String(it.batchNo).trim() !== '') {
      batchNo = String(it.batchNo).trim();
      if (batchNo.length > 64) throw invalid('batchNo', 'Batch number is too long', { index });
    }
    let expiryDate = null;
    if (it.expiryDate != null && it.expiryDate !== '') {
      expiryDate = isoDay(it.expiryDate);
      if (!expiryDate) throw invalid('expiryDate', 'Expiry must be a date (YYYY-MM-DD)', { index });
    }
    total += copies;
    return { invItemId, copies, batchNo, expiryDate };
  });
  assertTotal(total);
  return { layout: p.layout, hotelId, items };
}

/**
 * Label PDF for chosen items. Needs inventory.update on `hotelId` when given
 * (its bins are printed), else in each item's company (no bins).
 *
 * @param {object} t    connection (reads only; pass `db`, not a transaction)
 * @param {object} user req.user
 * @param {{layout:string, hotelId?:number, items:Array<{invItemId:number,
 *   copies?:number, batchNo?:string, expiryDate?:'YYYY-MM-DD'}>}} payload
 * @returns {Promise<{url:string}>}
 * @throws InventoryError VALIDATION (field: layout | hotelId | items |
 *   invItemId | copies | batchNo | expiryDate), NOT_FOUND (item or hotel
 *   outside scope), FORBIDDEN (visible, but no inventory.update)
 */
export async function renderItemLabels(t, user, payload) {
  const { layout, hotelId, items } = validateItemsPayload(payload);
  const ids = [...new Set(items.map((i) => i.invItemId))];
  const rows = await t.any(
    `SELECT i.id, i.hospitality_company_id, i.display_name, i.item_code, i.stock_uom, hi.bin_label
       FROM tbl_inv_item i
       LEFT JOIN tbl_inv_hotel_item hi ON hi.inv_item_id = i.id AND hi.hotel_id = $2
      WHERE i.id = ANY($1::int[])`,
    [ids, hotelId]
  );
  if (rows.length !== ids.length) throw itemNotFound();
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const companies = [...new Set(rows.map((r) => Number(r.hospitality_company_id)))];

  if (hotelId) {
    const { companyId } = await assertHotelPermission(t, user, {
      resource: 'inventory', action: 'update', hotelId,
    });
    if (companies.some((c) => c !== companyId)) throw itemNotFound();
  } else {
    for (const companyId of companies) await assertUpdateInCompany(t, user, companyId);
  }

  const labels = [];
  for (const it of items) {
    const row = byId.get(it.invItemId);
    const label = {
      invItemId: it.invItemId,
      name: row.display_name,
      itemCode: row.item_code,
      stockUom: row.stock_uom,
      binLabel: hotelId ? row.bin_label : null,
      batchNo: it.batchNo,
      expiryDate: it.expiryDate,
    };
    for (let n = 0; n < it.copies; n += 1) labels.push(label);
  }
  return renderAndUpload({ layout, labels, companyId: companies[0], name: 'items' });
}

/**
 * Label PDF for a receipt GRN: one label per stock unit (`per_unit`, the
 * line's stock qty, e.g. 24 bottles for 2 cases of 12) or per pack
 * (`per_pack`, the accepted qty in the PO unit). Fractions round up. Lines
 * with nothing accepted, or not yet tied to a stock item, print nothing.
 * Batch and expiry come from the GRN line; bins from the GRN's hotel.
 *
 * @param {object} t    connection (reads only)
 * @param {object} user req.user
 * @param {number|string} grnId
 * @param {{layout:string, mode?:'per_unit'|'per_pack'}} payload  mode defaults to per_unit
 * @returns {Promise<{url:string}>}
 * @throws InventoryError NOT_FOUND 'GRN not found' (missing or foreign GRN,
 *   one message for both), FORBIDDEN (no grn.read at the GRN's hotel),
 *   VALIDATION (layout | mode | grnId for a draft, a reversal, a reversed
 *   receipt or nothing to label | copies over the cap)
 */
export async function renderGrnLabels(t, user, grnId, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  layoutOf(p.layout);
  const mode = p.mode == null ? 'per_unit' : p.mode;
  if (!GRN_LABEL_MODES.includes(mode)) throw invalid('mode', 'Print per unit or per pack');

  const id = positiveInt(grnId);
  const grn = id
    ? await t.oneOrNone(
      `SELECT id, grn_number, hotel_id, hospitality_company_id, doc_type, status FROM tbl_grn WHERE id = $1`,
      [id]
    )
    : null;
  if (!grn) throw grnNotFound();
  try {
    await assertHotelPermission(t, user, { resource: 'grn', action: 'read', hotelId: Number(grn.hotel_id) });
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw grnNotFound();
    throw err;
  }
  if (grn.doc_type !== 'RECEIPT' || grn.status === 'reversed') {
    throw invalid('grnId', 'Labels are printed from a receipt that still stands');
  }
  // A draft has put nothing in stock yet; its quantities can still change.
  if (grn.status === 'draft') throw invalid('grnId', 'Post the receipt before printing labels');

  const lines = await t.any(
    `SELECT gl.inv_item_id, gl.accepted_qty::text AS accepted_qty, gl.uom_factor::text AS uom_factor,
            gl.stock_qty::text AS stock_qty, gl.batch_no, gl.expiry_date::text AS expiry_date,
            i.display_name, i.item_code, i.stock_uom, hi.bin_label
       FROM tbl_grn_line gl
       JOIN tbl_inv_item i ON i.id = gl.inv_item_id
       LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = $2 AND hi.inv_item_id = gl.inv_item_id
      WHERE gl.grn_id = $1 AND gl.accepted_qty > 0
      ORDER BY gl.id`,
    [id, grn.hotel_id]
  );

  let total = 0;
  const plan = lines.map((l) => {
    const stockQty = l.stock_qty != null
      ? Number(l.stock_qty)
      : Number(l.accepted_qty) * (l.uom_factor != null ? Number(l.uom_factor) : 1);
    const copies = labelCount(mode === 'per_unit' ? stockQty : l.accepted_qty);
    total += copies;
    return { l, copies };
  });
  if (!plan.length) throw invalid('grnId', 'Nothing on this GRN to label');
  assertTotal(total);

  const labels = [];
  for (const { l, copies } of plan) {
    const label = {
      invItemId: Number(l.inv_item_id),
      name: l.display_name,
      itemCode: l.item_code,
      stockUom: l.stock_uom,
      binLabel: l.bin_label,
      batchNo: l.batch_no,
      expiryDate: l.expiry_date,
    };
    for (let n = 0; n < copies; n += 1) labels.push(label);
  }
  return renderAndUpload({
    layout: p.layout,
    labels,
    companyId: Number(grn.hospitality_company_id),
    name: `grn-${grn.grn_number || id}`,
  });
}

export default { LABEL_LAYOUTS, MAX_LABELS, renderLabelsHtml, renderItemLabels, renderGrnLabels };
