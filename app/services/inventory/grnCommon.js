// Shared by the GRN modules (grnService.js is the public entry): receiving
// constants, quantity and date helpers, access checks, and the row writers
// both posting and reversal use (GRN lines, PO roll-ups after a receipt).
//
// Quantities are integers of 1/10000 (toQ / qStr / qNum) so sums and
// tolerance checks have no float drift.

import { InventoryError } from './errors.js';
import { assertHotelPermission, assertVisibleHotelPermission } from './scope.js';
import { recomputePoReceipt } from './receiptRollup.js';
import { advanceLegacyPoStatus } from './poStatus.js';

/** po.status values a PO can be received in (spec §6.2). */
export const RECEIVABLE_PO_STATUSES = Object.freeze(['approved', 'dispatched', 'GRN', 'invoice_raised']);
/** po.receipt_status values with nothing left to receive. */
const CLOSED_RECEIPT_STATUSES = new Set(['received', 'closed_short']);
export const REJECTION_REASONS = Object.freeze([
  'damaged', 'quality', 'wrong_item', 'short_shelf_life', 'temperature', 'excess', 'other',
]);
export const ATTACHMENT_KINDS = Object.freeze(['CHALLAN', 'INVOICE', 'PHOTO', 'OTHER']);
/** Name stamped on site-rep (token) receipts, which have no user. */
export const SITE_REP_ACTOR = Object.freeze({ id: null, name: 'Site representative' });

export const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
export const LIST_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const SCALE = 10000;
export const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
/** NUMERIC(18,4) value (number or decimal string) → integer of 1/10000. */
export const toQ = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * SCALE) : NaN;
};
export const qNum = (q) => q / SCALE;
/** Exact decimal string of a 1/10000 integer, for NUMERIC parameters. */
export const qStr = (q) => {
  const a = Math.abs(q);
  return `${q < 0 ? '-' : ''}${Math.floor(a / SCALE)}.${String(a % SCALE).padStart(4, '0')}`;
};
export const sum = (list) => list.reduce((a, b) => a + b, 0);
export const round4 = (n) => Math.round(n * 1e4) / 1e4;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;
export const toIso = (v) => (v == null ? null : new Date(v).toISOString());
export const numOrNull = (v) => (v == null ? null : Number(v));
export const textOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export const notFound = (what = 'Not found', details = {}) => new InventoryError('NOT_FOUND', what, details);
export const invalid = (message, details = {}) => new InventoryError('VALIDATION', message, details);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A 'YYYY-MM-DD' calendar day, or null. Throws VALIDATION on anything else. */
export function isoDay(value, field) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!DAY_RE.test(s)) throw invalid(`${field} must be a date (YYYY-MM-DD)`, { field });
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw invalid(`${field} is not a valid date`, { field });
  }
  return s;
}
export const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function clientEventIdOf(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!UUID_RE.test(s)) throw invalid('clientEventId must be a UUID', { field: 'clientEventId' });
  return s.toLowerCase();
}

export function quantityQ(value, field, index) {
  const q = value == null || value === '' ? 0 : toQ(value);
  if (!Number.isFinite(q) || q < 0) {
    throw invalid(`${field} must be a number of 0 or more`, { field, index });
  }
  return q;
}

/** S3 location of a stored attachment key (legacy rows may hold a full URL). */
export function attachmentUrl(s3Key) {
  if (!s3Key) return null;
  if (/^https?:\/\//i.test(s3Key)) return s3Key;
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
}

/** The key to store for an S3 URL: the object key when it is our bucket, else the URL itself. */
export function attachmentKeyFromUrl(url) {
  const s = textOrNull(url);
  if (!s) return null;
  try {
    const u = new URL(s);
    const bucket = process.env.AWS_S3_BUCKET;
    if (bucket && u.hostname.startsWith(`${bucket}.s3.`)) return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    // not a URL: stored as given
  }
  return s;
}

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

export function assertReceivable(ctx) {
  if (!RECEIVABLE_PO_STATUSES.includes(ctx.status) || CLOSED_RECEIPT_STATUSES.has(ctx.receiptStatus)) {
    const message = CLOSED_RECEIPT_STATUSES.has(ctx.receiptStatus)
      ? 'Nothing is left to receive on this purchase order'
      : 'This purchase order cannot be received yet';
    throw new InventoryError('CONFLICT', message, {
      reason: 'PO_NOT_RECEIVABLE', status: ctx.status, receiptStatus: ctx.receiptStatus,
    });
  }
}

/** A site-rep token must be a GRN token for this PO (and its hotel, when bound). */
export async function assertToken(t, viaToken, poId, hotelId) {
  const tokenId = positiveInt(viaToken?.tokenId);
  const row = tokenId
    ? await t.oneOrNone(
      `SELECT id, entity_id, hotel_id FROM tbl_token_login_data WHERE id = $1 AND token_type = 'GRN'`,
      [tokenId]
    )
    : null;
  if (!row || Number(row.entity_id) !== Number(poId)) throw notFound('Purchase order not found');
  // The hotel stored on the token wins; a caller-side hotel may only agree with it.
  const stored = numOrNull(row.hotel_id);
  const asked = positiveInt(viaToken.hotelId);
  if (stored && asked && stored !== asked) throw notFound('Purchase order not found');
  const bound = stored ?? asked;
  if (bound && hotelId && bound !== Number(hotelId)) throw notFound('Purchase order not found');
  return { tokenId, hotelId: bound };
}

/** The hotel a site-rep token is bound to (stored on the token, else the caller's), or null. */
export async function tokenHotelId(t, viaToken) {
  const tokenId = positiveInt(viaToken?.tokenId);
  const row = tokenId
    ? await t.oneOrNone(`SELECT hotel_id FROM tbl_token_login_data WHERE id = $1`, [tokenId])
    : null;
  return numOrNull(row?.hotel_id) ?? positiveInt(viaToken?.hotelId);
}

/**
 * Who may receive this PO at this hotel: the hotel must be in the PO's hotel
 * set (else NOT_FOUND), and the user must hold grn.<action> there. Rule C3:
 * without grn.read or grn.<action> at the hotel the PO reads as missing
 * (NOT_FOUND 'Purchase order not found', inside the caller's company too);
 * seeing it without the action is FORBIDDEN.
 * A site-rep token is bound to its PO (and hotel) instead.
 */
export async function assertReceiveAccess(t, actor, ctx, hotelId, { viaToken = null, action = 'create' } = {}) {
  const hotel = positiveInt(hotelId);
  if (!hotel || !ctx.companyId || !ctx.hotelIds.includes(hotel)) {
    throw notFound('Purchase order not found');
  }
  if (viaToken) {
    await assertToken(t, viaToken, ctx.po.id, hotel);
    return;
  }
  await assertVisibleHotelPermission(t, actor, { resource: 'grn', action, hotelId: hotel, missing: 'Purchase order not found' });
}

/**
 * Access to an existing GRN: no grn.read on its hotel = NOT_FOUND (the caller
 * cannot see it, another company's GRN included: the same answer as a missing
 * id); grn.read but not grn.<action> = FORBIDDEN. A token may only touch GRNs
 * of its own PO and hotel.
 */
export async function assertGrnAccess(t, user, grn, action = 'read', { viaToken = null } = {}) {
  if (viaToken) {
    await assertToken(t, viaToken, grn.po_id, grn.hotel_id);
    return;
  }
  try {
    await assertHotelPermission(t, user, { resource: 'grn', action: 'read', hotelId: grn.hotel_id });
  } catch (err) {
    if (err instanceof InventoryError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) throw notFound('GRN not found');
    throw err;
  }
  if (action !== 'read') {
    await assertHotelPermission(t, user, { resource: 'grn', action, hotelId: grn.hotel_id });
  }
}

export async function loadGrnRow(t, grnId, { forUpdate = false } = {}) {
  const id = positiveInt(grnId);
  if (!id) throw notFound('GRN not found');
  const row = await t.oneOrNone(
    `SELECT id, grn_number, hospitality_company_id, hotel_id, po_id, dispatch_id, doc_type, reverses_grn_id,
            status, received_at::text AS received_at, received_by, received_by_token_id,
            vendor_challan_no, vendor_challan_date::text AS vendor_challan_date, vendor_invoice_no,
            vendor_invoice_date::text AS vendor_invoice_date, eway_bill_no, vehicle_no, remarks,
            client_event_id
       FROM tbl_grn WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!row) throw notFound('GRN not found');
  return row;
}

/** Lazily checked inventory.update (unit conversions, variant mapping). */
export function inventoryUpdateGate(t, actor, hotelId, viaToken) {
  let granted = false;
  return async () => {
    if (granted) return;
    if (viaToken) {
      throw new InventoryError('FORBIDDEN', 'Ask your inventory controller to set the unit conversion', {
        resource: 'inventory', action: 'update', hotelId,
      });
    }
    await assertHotelPermission(t, actor, { resource: 'inventory', action: 'update', hotelId });
    granted = true;
  };
}

// ---------------------------------------------------------------------------
// category defaults
// ---------------------------------------------------------------------------

/**
 * Company category defaults for variants (any category or ancestor counts,
 * as lazy item creation reads them): {trackExpiry, markOutOnArrival}.
 */
export async function categoryDefaults(t, companyId, variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, { trackExpiry: false, markOutOnArrival: false }]));
  if (!ids.length) return out;
  const rows = await t.any(
    `WITH RECURSIVE cats AS (
       SELECT pv.id AS variant_id, pc.category_id AS id, 1 AS depth
         FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pv.id = ANY($2::int[]) AND pc.category_id IS NOT NULL
       UNION
       SELECT cats.variant_id, c.parent_id, cats.depth + 1
         FROM cats JOIN tbl_category c ON c.id = cats.id
        WHERE c.parent_id IS NOT NULL AND c.parent_id > 0 AND cats.depth < 6
     )
     SELECT cats.variant_id,
            bool_or(cd.track_expiry) AS track_expiry,
            bool_or(cd.default_mark_out_on_arrival) AS mark_out
       FROM cats
       JOIN tbl_inv_category_default cd ON cd.category_id = cats.id AND cd.hospitality_company_id = $1
      GROUP BY cats.variant_id`,
    [companyId, ids]
  );
  for (const r of rows) {
    out.set(Number(r.variant_id), { trackExpiry: r.track_expiry === true, markOutOnArrival: r.mark_out === true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GRN line writes
// ---------------------------------------------------------------------------

// The per-line values of a GRN line row, in GRN_LINE_COLUMNS order (after id,
// company, grn and before created_by / updated_by).
const grnLineValues = (line) => [
  line.poLineId, line.productVariantId ?? null, line.invItemId ?? null,
  line.reversesGrnLineId ?? null, String(line.poUom ?? '').slice(0, 99),
  qStr(line.receivedQ), qStr(line.acceptedQ), qStr(line.rejectedQ), line.rejectionReason ?? null,
  line.uomFactor ?? null, line.stockQ == null ? null : qStr(line.stockQ), line.unitCost ?? null,
  line.markOutDepartmentId ?? null, line.batchNo ?? null, line.mfgDate ?? null, line.expiryDate ?? null,
  line.remarks ?? null,
];

export async function insertGrnLine(t, { companyId, grnId, userId, line }) {
  const row = await t.one(
    `INSERT INTO tbl_grn_line
       (hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, reverses_grn_line_id, po_uom,
        received_qty, accepted_qty, rejected_qty, rejection_reason, uom_factor, stock_qty, unit_cost,
        mark_out_department_id, batch_no, mfg_date, expiry_date, remarks, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $20)
     RETURNING id`,
    [companyId, grnId, ...grnLineValues(line), userId]
  );
  return Number(row.id);
}

/**
 * insertGrnLine for many lines in one INSERT. The ids are drawn from the
 * sequence first, so line k gets ids[k] and the lines keep their input order
 * by id, as one insert per line did.
 * @returns {Promise<number[]>} the new ids, in input order
 */
export async function insertGrnLines(t, { companyId, grnId, userId, lines }) {
  if (!lines.length) return [];
  const ids = (await t.any(
    `SELECT nextval(pg_get_serial_sequence('public.tbl_grn_line', 'id'))::int AS id
       FROM generate_series(1, $1) ORDER BY 1`,
    [lines.length]
  )).map((r) => Number(r.id));
  const cols = lines.map(grnLineValues);
  const col = (k) => cols.map((v) => v[k]);
  await t.none(
    `INSERT INTO tbl_grn_line
       (id, hospitality_company_id, grn_id, po_line_id, product_variant_id, inv_item_id, reverses_grn_line_id, po_uom,
        received_qty, accepted_qty, rejected_qty, rejection_reason, uom_factor, stock_qty, unit_cost,
        mark_out_department_id, batch_no, mfg_date, expiry_date, remarks, created_by, updated_by)
     SELECT v.id, $1, $2, v.po_line_id, v.product_variant_id, v.inv_item_id, v.reverses_grn_line_id, v.po_uom,
            v.received_qty, v.accepted_qty, v.rejected_qty, v.rejection_reason, v.uom_factor, v.stock_qty, v.unit_cost,
            v.mark_out_department_id, v.batch_no, v.mfg_date::date, v.expiry_date::date, v.remarks, $3, $3
       FROM unnest($4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::text[],
                   $10::numeric[], $11::numeric[], $12::numeric[], $13::text[], $14::numeric[], $15::numeric[],
                   $16::numeric[], $17::int[], $18::text[], $19::text[], $20::text[], $21::text[])
         AS v(id, po_line_id, product_variant_id, inv_item_id, reverses_grn_line_id, po_uom,
              received_qty, accepted_qty, rejected_qty, rejection_reason, uom_factor, stock_qty, unit_cost,
              mark_out_department_id, batch_no, mfg_date, expiry_date, remarks)
      ORDER BY v.id`,
    [companyId, grnId, userId, ids, ...Array.from({ length: 17 }, (_, k) => col(k))]
  );
  return ids;
}

// ---------------------------------------------------------------------------
// stock qty of a return or reversal part
// ---------------------------------------------------------------------------

/**
 * The stock qty (stock units, 4 dp) of taking `qtyQ` more PO units out of
 * each receipt line, by a return to vendor or a reversal, so that the parts
 * of one line never add up to more than it stocked (E1 M-2). Each part is
 * cumulative, not rounded on its own:
 *   part = ROUND((before + qty) × factor, 4) − stock already taken out,
 * and the part that empties the line (before + qty = accepted) takes exactly
 * what is left of its stock_qty. A part is capped at what is left and is
 * never below 0. "Before" and "taken out" count dispatched or closed returns
 * (their RTV_OUT ledger rows) and posted reversals (their lines' stock_qty);
 * drafts count for neither. In SQL numeric, so 1.0003 × 1.5 is 1.5005.
 *
 * factor = the line's uom_factor, else stock_qty / accepted_qty.
 *
 * @param {object} t transaction
 * @param {Array<{grnLineId:number, qtyQ:number}>} lines qtyQ a 1/10000 integer (PO units)
 * @returns {Promise<Map<number, number|null>>} part per receipt line, a 1/10000
 *   integer; null when the line has no unit conversion.
 */
export async function returnStockParts(t, lines) {
  if (!lines.length) return new Map();
  const rows = await t.any(
    `WITH v AS (
       SELECT * FROM unnest($1::int[], $2::numeric[]) AS v(grn_line_id, qty)
     ), base AS (
       SELECT v.grn_line_id, v.qty, gl.accepted_qty,
              CASE WHEN gl.uom_factor > 0 THEN gl.uom_factor
                   WHEN gl.stock_qty > 0 AND gl.accepted_qty > 0 THEN gl.stock_qty / gl.accepted_qty
              END AS f,
              gl.stock_qty
         FROM v JOIN tbl_grn_line gl ON gl.id = v.grn_line_id
     ), taken AS (
       SELECT b.*,
              COALESCE(b.stock_qty, ROUND(b.accepted_qty * b.f, 4)) AS total,
              COALESCE((SELECT SUM(rl.qty)
                          FROM tbl_rtv_line rl JOIN tbl_rtv r ON r.id = rl.rtv_id
                         WHERE rl.grn_line_id = b.grn_line_id AND r.status IN ('dispatched', 'closed')), 0)
              + COALESCE((SELECT SUM(ABS(x.accepted_qty))
                            FROM tbl_grn_line x JOIN tbl_grn xg ON xg.id = x.grn_id
                           WHERE x.reverses_grn_line_id = b.grn_line_id AND xg.doc_type = 'REVERSAL'
                             AND xg.status <> 'draft'), 0) AS qty_before,
              COALESCE((SELECT SUM(-m.qty)
                          FROM tbl_rtv_line rl
                          JOIN tbl_rtv r ON r.id = rl.rtv_id
                          JOIN tbl_inv_movement m ON m.source_type = 'RTV' AND m.source_id = r.id
                                                 AND m.source_line_id = rl.id AND m.movement_type = 'RTV_OUT'
                         WHERE rl.grn_line_id = b.grn_line_id AND r.status IN ('dispatched', 'closed')), 0)
              + COALESCE((SELECT SUM(ABS(x.stock_qty))
                            FROM tbl_grn_line x JOIN tbl_grn xg ON xg.id = x.grn_id
                           WHERE x.reverses_grn_line_id = b.grn_line_id AND xg.doc_type = 'REVERSAL'
                             AND xg.status <> 'draft'), 0) AS stock_before
         FROM base b
     )
     SELECT grn_line_id,
            CASE WHEN f IS NULL THEN NULL
                 WHEN qty <= 0 THEN 0
                 ELSE GREATEST(0, LEAST(total - stock_before,
                        CASE WHEN qty_before + qty >= accepted_qty THEN total
                             ELSE ROUND((qty_before + qty) * f, 4)
                        END - stock_before))
            END::text AS part
       FROM taken`,
    [lines.map((l) => l.grnLineId), lines.map((l) => qStr(l.qtyQ))]
  );
  return new Map(rows.map((r) => [Number(r.grn_line_id), r.part == null ? null : toQ(r.part)]));
}

// ---------------------------------------------------------------------------
// PO roll-ups after a receipt or reversal
// ---------------------------------------------------------------------------

/** Roll-ups and side effects of any posted receipt or reversal (same tx). */
export async function afterReceiptChange(t, poId, { dispatchId = null, userId = null } = {}) {
  await recomputePoReceipt(t, poId);
  await advanceLegacyPoStatus(t, poId, 'GRN');
  await t.none(
    `UPDATE tbl_rfq_purchase_order SET delivery_plan_locked_at = now()
      WHERE id = $1 AND delivery_plan_locked_at IS NULL`,
    [poId]
  );
  if (dispatchId) {
    await t.none(
      `UPDATE tbl_po_dispatch SET status = 'received', updated_at = now(), updated_by = $2
        WHERE id = $1 AND status = 'in_transit'`,
      [dispatchId, userId]
    );
  }
}
