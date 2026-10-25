// Vendor invoices, one per delivery (spec §5.2 "Invoices", task C4).
//
// An invoice is a tbl_purchase_order_document row (document_type 'invoice')
// carrying the vendor's invoice number, date and amount and, optionally, the
// dispatch note it bills. A PO takes as many invoices as it has deliveries:
// the old "one invoice per PO" guard is gone. Matching invoices to GRNs is a
// later layer.
//
// The legacy body (a file and nothing else, from screens built before
// invoices had numbers) still raises an invoice, but only one such: a second
// file-only invoice on the same PO (a double click, a retry) has nothing to
// tell it apart, so it is refused. Numbered invoices are unique per PO
// (case- and space-insensitive), checked under the PO row lock.
//
// po.status only moves forward (advanceLegacyPoStatus): an invoice raised
// before the goods arrive moves an accepted PO to invoice_raised, and the GRN
// that follows does not move it back (D6). A completed PO stays completed.
//
// Ownership: only the PO's own vendor (finalized_vendor_id, user_type 3), and
// like the vendor's PO list a PO not released to them is not found. Tenancy
// comes from the PO row, never the request body.

import { InventoryError } from './errors.js';
import { getPoContext } from './planCore.js';
import { advanceLegacyPoStatus } from './poStatus.js';
import { parseDay } from './planService.js';
import { INVALID_PO_STATUSES_FOR_VENDOR } from '../../util/constants.js';
import { resolvePoTenancy } from '../../models/purchaseOrderModel.js';

/** PO statuses an invoice can be raised on: accepted by the vendor, or completed. */
export const INVOICEABLE_PO_STATUSES = Object.freeze(['approved', 'dispatched', 'GRN', 'invoice_raised', 'completed']);
export const INVOICE_NUMBER_MAX = 64;

const DETAIL_KEYS = ['invoice_number', 'invoice_date', 'invoice_amount', 'dispatch_id'];
// numeric(18,4) holds 14 whole digits; an invoice amount has at most 2 decimals.
const AMOUNT = /^\d{1,14}(\.\d{1,2})?$/;
const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;

/** A validated amount ("4500", "007.5") as stored: 2 decimals, no float round trip. */
const padAmount = (text) => {
  const [whole, frac = ''] = text.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}`;
};

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const invalid = (field, message) => new InventoryError('VALIDATION', message, { field });
const notFound = (poId) => new InventoryError('NOT_FOUND', 'Purchase order not found', { poId: poId ?? null });

/**
 * The invoice details of a /po/raiseInvoice body, validated.
 * A body that names none of them is the legacy file-only invoice.
 *
 * @param {object} body {invoice_number, invoice_date, invoice_amount, dispatch_id?}
 * @returns {{legacy:boolean, invoiceNumber:string|null, invoiceDate:string|null,
 *   invoiceAmount:string|null, dispatchId:number|null}} the amount as a
 *   decimal string with 2 places.
 * @throws InventoryError VALIDATION {field}
 */
export function parseInvoiceDetails(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (DETAIL_KEYS.every((k) => blank(b[k]))) {
    return { legacy: true, invoiceNumber: null, invoiceDate: null, invoiceAmount: null, dispatchId: null };
  }

  const rawNumber = b.invoice_number;
  if (!['string', 'number'].includes(typeof rawNumber) || String(rawNumber).trim() === '') {
    throw invalid('invoice_number', 'Invoice number is required');
  }
  const invoiceNumber = String(rawNumber).trim().replace(/\s+/g, ' ');
  if (invoiceNumber.length > INVOICE_NUMBER_MAX) {
    throw invalid('invoice_number', `Invoice number is limited to ${INVOICE_NUMBER_MAX} characters`);
  }

  if (blank(b.invoice_date)) throw invalid('invoice_date', 'Invoice date is required');
  const invoiceDate = parseDay(b.invoice_date);
  if (!invoiceDate) throw invalid('invoice_date', 'Invoice date must be a date (YYYY-MM-DD)');

  const rawAmount = b.invoice_amount;
  const amountText = typeof rawAmount === 'number'
    ? (Number.isFinite(rawAmount) ? String(rawAmount) : '')
    : typeof rawAmount === 'string' ? rawAmount.trim() : '';
  if (!amountText) throw invalid('invoice_amount', 'Invoice amount is required');
  if (!AMOUNT.test(amountText) || !(Number(amountText) > 0)) {
    throw invalid('invoice_amount', 'Invoice amount must be more than zero, with at most 2 decimals');
  }
  const invoiceAmount = padAmount(amountText);

  let dispatchId = null;
  if (!blank(b.dispatch_id)) {
    const raw = b.dispatch_id;
    dispatchId = (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim())))
      ? positiveInt(typeof raw === 'string' ? raw.trim() : raw)
      : null;
    if (!dispatchId || dispatchId > 2147483647) throw invalid('dispatch_id', 'Pick one of your dispatch notes on this purchase order');
  }

  return { legacy: false, invoiceNumber, invoiceDate, invoiceAmount, dispatchId };
}

/**
 * Raise a vendor invoice against a PO (contract: POST /po/raiseInvoice).
 * Writes the document row, moves po.status forward to invoice_raised, and
 * adds the 'invoice' step to the PO's legacy approval timeline.
 *
 * @param {object} t transaction
 * @param {object} actor the vendor (req.user: {id, user_type: 3})
 * @param {number} poId
 * @param {{invoiceUrl:string, body:object}} input invoiceUrl already checked to
 *   be one of our S3 objects; body = the request body (parseInvoiceDetails).
 * @returns {Promise<{document:object, invoice:object, scope:object, details:object}>}
 *   `document` is the inserted row (the route's legacy response), `invoice`
 *   the vendor view (loadInvoices shape), `scope` the activity-log scope.
 * @throws InventoryError VALIDATION | NOT_FOUND (not the vendor's PO; a
 *   dispatch of another PO) | CONFLICT (PO not accepted; dispatch cancelled;
 *   duplicate invoice number; a second file-only invoice)
 */
export async function raiseInvoice(t, actor, poId, { invoiceUrl, body } = {}) {
  const details = parseInvoiceDetails(body);
  const id = positiveInt(poId);
  if (!id) throw notFound(poId);

  // The lock serialises invoices on one PO, so the duplicate checks below hold.
  const po = await t.oneOrNone(
    `SELECT id, status::text AS status, finalized_vendor_id FROM tbl_rfq_purchase_order WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (!po) throw notFound(id);
  const vendorId = positiveInt(actor?.id);
  if (!vendorId || Number(actor?.user_type) !== 3 || Number(po.finalized_vendor_id) !== vendorId) throw notFound(id);
  if (INVALID_PO_STATUSES_FOR_VENDOR.includes(po.status)) throw notFound(id);
  if (!INVOICEABLE_PO_STATUSES.includes(po.status)) {
    throw new InventoryError(
      'CONFLICT',
      po.status === 'rejected_by_vendor'
        ? 'This purchase order was rejected; nothing can be invoiced against it'
        : 'Invoices can be raised once you have accepted the purchase order',
      { poStatus: po.status }
    );
  }
  if (!invoiceUrl) throw invalid('invoice_url', 'Please attach the invoice document');

  if (details.invoiceDate) {
    const { today } = await t.one(`SELECT ${IST_TODAY}::text AS today`);
    if (details.invoiceDate > today) throw invalid('invoice_date', 'The invoice date cannot be in the future');
  }

  let dispatch = null;
  if (details.dispatchId) {
    dispatch = await t.oneOrNone(
      `SELECT id, hotel_id, status, dispatch_number FROM tbl_po_dispatch WHERE id = $1 AND po_id = $2`,
      [details.dispatchId, id]
    );
    if (!dispatch) throw new InventoryError('NOT_FOUND', 'Dispatch not found', { dispatchId: details.dispatchId });
    if (dispatch.status === 'cancelled') {
      throw new InventoryError('CONFLICT', `Dispatch ${dispatch.dispatch_number} was cancelled; invoice the delivery that went instead`, {
        field: 'dispatch_id', dispatchId: details.dispatchId,
      });
    }
  }

  if (details.legacy) {
    const unnumbered = await t.oneOrNone(
      `SELECT 1 FROM tbl_purchase_order_document
        WHERE purchase_order_id = $1 AND document_type = 'invoice' AND invoice_number IS NULL
        LIMIT 1`,
      [id]
    );
    if (unnumbered) {
      throw new InventoryError(
        'CONFLICT',
        'An invoice is already on this purchase order. To add another, give its invoice number, date and amount.',
        { field: 'invoice_number' }
      );
    }
  } else {
    const dup = await t.oneOrNone(
      `SELECT 1 FROM tbl_purchase_order_document
        WHERE purchase_order_id = $1 AND document_type = 'invoice'
          AND lower(regexp_replace(btrim(invoice_number), '\\s+', ' ', 'g')) = lower($2)
        LIMIT 1`,
      [id, details.invoiceNumber]
    );
    if (dup) {
      throw new InventoryError('CONFLICT', `Invoice ${details.invoiceNumber} is already on this purchase order`, {
        field: 'invoice_number',
      });
    }
  }

  const document = await t.one(
    `INSERT INTO tbl_purchase_order_document
       (purchase_order_id, document_type, document_url, uploaded_by, invoice_number, invoice_date, invoice_amount, dispatch_id)
     VALUES ($1, 'invoice', $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [id, invoiceUrl, vendorId, details.invoiceNumber, details.invoiceDate, details.invoiceAmount, details.dispatchId]
  );

  await advanceLegacyPoStatus(t, id, 'invoice_raised');

  // The PO's legacy approval timeline records the action (as before).
  const txn = await t.oneOrNone(
    `SELECT id FROM tbl_approval_hierarchy_transactions
      WHERE hierarchy_type = 'po' AND target_entity_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [id]
  );
  if (txn) {
    await t.none(
      `INSERT INTO tbl_approval_hierarchy_history (approval_transaction_id, approved_by, action)
       VALUES ($1, $2, 'invoice')`,
      [txn.id, vendorId]
    );
  }

  // The trail files the invoice under the hotel it bills: its dispatch's,
  // else the PO's only hotel, else (a multi-hotel PO, no dispatch named) the
  // PO's own hotel.
  const ctx = await getPoContext(t, id);
  const billedHotel = dispatch?.hotel_id == null ? null : Number(dispatch.hotel_id);
  let hotelId = billedHotel ?? (ctx.hotelIds.length === 1 ? ctx.hotelIds[0] : null);
  if (hotelId == null) {
    const tenancy = await resolvePoTenancy(id, t);
    hotelId = positiveInt(tenancy?.hotel_id) ?? ctx.hotelIds[0] ?? null;
  }
  const scope = {
    hospitalityCompanyId: ctx.companyId,
    hotelId,
    entityLabel: ctx.po.po_number || null,
  };
  const [invoice] = await loadInvoices(t, id, { documentId: Number(document.id) });
  return { document, invoice, scope, details };
}

/**
 * A PO's invoices, oldest first: the vendor view (no buyer data at all).
 * File-only invoices from before numbers carry null number, date and amount.
 *
 * @returns {Promise<Array<{id, invoiceNumber, invoiceDate, invoiceAmount:number|null,
 *   dispatchId, dispatchNumber, documentUrl, createdAt}>>}
 */
export async function loadInvoices(t, poId, { documentId = null } = {}) {
  const rows = await t.any(
    `SELECT d.id, d.invoice_number, d.invoice_date::text AS invoice_date, d.invoice_amount::text AS invoice_amount,
            d.dispatch_id, pd.dispatch_number, d.document_url, d.created_at
       FROM tbl_purchase_order_document d
       LEFT JOIN tbl_po_dispatch pd ON pd.id = d.dispatch_id
      WHERE d.purchase_order_id = $1 AND d.document_type = 'invoice'
        AND ($2::int IS NULL OR d.id = $2)
      ORDER BY d.id`,
    [poId, documentId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    invoiceNumber: r.invoice_number ?? null,
    invoiceDate: r.invoice_date ?? null,
    invoiceAmount: r.invoice_amount == null ? null : Number(r.invoice_amount),
    dispatchId: r.dispatch_id == null ? null : Number(r.dispatch_id),
    dispatchNumber: r.dispatch_number ?? null,
    documentUrl: r.document_url,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

export default { raiseInvoice, loadInvoices, parseInvoiceDetails, INVOICEABLE_PO_STATUSES, INVOICE_NUMBER_MAX };
