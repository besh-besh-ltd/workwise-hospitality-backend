// Scan resolve and short links (spec §10).
//
// Every scan screen (receive, mark out, count, look up) sends what it read, from
// the camera, a keyboard-mode scanner or typed by hand, to resolveScan. It
// tries, in order:
//   1. our QR short URL, /s/<t>/<id> with or without a host
//      (t: i item, p PO, g GRN, d dispatch);
//   2. a GS1 code (GS1-128 / DataMatrix / DataBar): its GTIN is looked up as a
//      barcode alias, and batch / expiry / serial come back to prefill;
//   3. a plain barcode alias in tbl_inv_item_barcode (with its pack factor);
//   4. tbl_inv_item.item_code;
//   5. tbl_product_variant.sku of a variant mapped to a stock item.
// Steps 3-5 use the GTIN for a GS1 code and the raw code otherwise. Numeric
// EAN/UPC/GTIN codes match whatever their length (8, 12, 13 or 14 digits):
// they are compared as GTIN-14, so a UPC-A alias matches its EAN-13 or GS1 read,
// and a UPC-E is expanded to its UPC-A (not zero-padded) on either side.
//
// Scope (spec §6.1, §10.1): the context is `po:<id>` or `hotel:<id>`, and the
// caller needs grn.read or inventory.read on that hotel / one of the PO's
// hotels (a foreign context is 404, a visible one without the grant 403). With
// no context, the companies of the caller's own readable hotels are searched.
// Codes resolve inside that company only, so another tenant's code is simply
// 'unknown'. In a PO context only items on the PO's lines are candidates (and
// the result carries the poLineId); anything else is 'unknown' too. In a hotel
// context every company item resolves, with stockedAtHotel saying whether the
// hotel has a balance or hotel-item row for it. Our own item QR resolves with
// GRN rights alone (grn.read / grn.create), as receiving scans it.
//
// resolveShortLink answers the /s/<t>/<id> page: the frontend route to open,
// or NOT_FOUND (404) for anything missing or outside the caller's scope.
// Vendors and site-rep token users never resolve anything.

import { InventoryError } from './errors.js';
import { hotelIdsWithPermission, assertHotelPermission } from './scope.js';
import { getPoContext } from './planCore.js';
import { assertPoAccess } from '../../models/purchaseOrderModel.js';
import { inventoryGrn, inventoryPoDeliveries } from '../notificationLinks.js';

const VENDOR = 3;
const MAX_CODE_LENGTH = 512;
const GS = '\x1d';

const positiveInt = (v) => {
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isOutsider = (user) =>
  !user || Number(user.user_type) === VENDOR || user.is_token_user === true;

const notFound = (what = 'Not found') => new InventoryError('NOT_FOUND', what);

// ─── GS1 ──────────────────────────────────────────────────────────────────────

// Application identifiers we can step over. `len` = fixed data length;
// `max` = variable length, ended by GS (FNC1) or the end of the code.
const AI_2 = {
  '00': { len: 18 }, '01': { len: 14 }, '02': { len: 14 },
  10: { max: 20 }, 11: { len: 6 }, 12: { len: 6 }, 13: { len: 6 }, 15: { len: 6 },
  16: { len: 6 }, 17: { len: 6 }, 20: { len: 2 }, 21: { max: 20 }, 22: { max: 20 },
  30: { max: 8 }, 37: { max: 8 },
};
const AI_3 = {
  240: { max: 30 }, 241: { max: 30 }, 250: { max: 30 }, 251: { max: 30 }, 254: { max: 20 },
  400: { max: 30 }, 401: { max: 30 }, 403: { max: 30 },
};

/** The AI at `pos` and its length rule, or null when we do not know it. */
function aiAt(s, pos) {
  const four = s.slice(pos, pos + 4);
  if (/^3[1-6]\d\d$/.test(four)) return { ai: four, len: 6 }; // measures, e.g. (3103) net kg
  const three = s.slice(pos, pos + 3);
  if (/^41[0-7]$/.test(three)) return { ai: three, len: 13 }; // GLNs
  if (AI_3[three]) return { ai: three, ...AI_3[three] };
  const two = s.slice(pos, pos + 2);
  if (AI_2[two]) return { ai: two, ...AI_2[two] };
  return null;
}

/** GS1 mod-10 check digit over every digit but the last. */
export function validGtinCheckDigit(digits) {
  if (!/^\d{8,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i -= 1, w = 4 - w) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * GS1 YYMMDD to 'YYYY-MM-DD'. Day 00 means the last day of the month. The
 * century follows the GS1 sliding window (General Specifications 7.12): the
 * year lands within 49 years back / 50 years ahead of the current one.
 */
function gs1Date(yymmdd, now = new Date()) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  const current = now.getUTCFullYear();
  const diff = yy - (current % 100);
  const century = Math.floor(current / 100) + (diff >= 51 ? -1 : diff <= -50 ? 1 : 0);
  const year = century * 100 + yy;
  if (mm < 1 || mm > 12) return null;
  const last = lastDayOfMonth(year, mm);
  if (dd === 0) dd = last;
  if (dd > last) return null;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// AIM symbology identifiers that announce GS1 data: ]C1 GS1-128, ]e0 DataBar,
// ]d2 GS1 DataMatrix, ]Q3 GS1 QR, ]J1 GS1 DotCode.
const GS1_PREFIX = /^\](C1|e0|d2|Q3|J1)/;
// Any AIM identifier (]C0 plain Code 128, ]E0 EAN-13, ...): stripped from
// plain codes before the lookup.
const ANY_AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;
const PAREN_FORM = /^(\(\d{2,4}\)[^()]*)+$/;

/**
 * Parse a GS1 element string: AIs (01) GTIN (fixed 14), (10) batch (variable,
 * ended by FNC1/GS or the end), (17) expiry YYMMDD (day 00 = last day of the
 * month) and (21) serial. Other common AIs are stepped over; an unknown one
 * ends the parse. Accepted forms: an AIM GS1 prefix (]C1, ]d2, ]e0, ]Q3, ]J1),
 * a leading GS, the human-readable "(01)…(17)…" form, or a bare string that
 * opens with (01) and a GTIN whose check digit is right.
 *
 * @returns {{gtin:string, batch:string|null, expiry:'YYYY-MM-DD'|null, serial:string|null}|null}
 *   null when the code is not GS1 or carries no GTIN.
 */
export function parseGs1(code) {
  if (typeof code !== 'string') return null;
  let s = code.replace(/^[\s]+|[\r\n\t ]+$/g, '');
  if (!s) return null;

  if (GS1_PREFIX.test(s)) s = s.slice(3);
  else if (s.startsWith(GS)) s = s.slice(1);
  else if (PAREN_FORM.test(s)) {
    s = s.replace(/\((\d{2,4})\)/g, `${GS}$1`).slice(1);
  } else if (!(/^01\d{14}/.test(s) && validGtinCheckDigit(s.slice(2, 16)))) {
    return null;
  }

  const out = { gtin: null, batch: null, expiry: null, serial: null };
  let pos = 0;
  while (pos < s.length) {
    if (s[pos] === GS) {
      pos += 1;
      continue;
    }
    const rule = aiAt(s, pos);
    if (!rule) break;
    pos += rule.ai.length;
    let value;
    if (rule.len) {
      value = s.slice(pos, pos + rule.len);
      if (value.length < rule.len || value.includes(GS)) break;
      pos += rule.len;
    } else {
      const end = s.indexOf(GS, pos);
      value = end === -1 ? s.slice(pos) : s.slice(pos, end);
      pos = end === -1 ? s.length : end + 1;
    }
    if (rule.ai === '01') {
      if (!/^\d{14}$/.test(value)) break;
      out.gtin = value;
    } else if (rule.ai === '10') out.batch = value || null;
    else if (rule.ai === '17') out.expiry = gs1Date(value);
    else if (rule.ai === '21') out.serial = value || null;
  }
  return out.gtin ? out : null;
}

// ─── Short URLs ───────────────────────────────────────────────────────────────

const SHORT_URL = /^(?:https?:\/\/[^/\s]+)?\/s\/([pgidPGID])\/(\d+)\/?(?:[?#].*)?$/;

/** Our QR payload /s/<t>/<id>, with or without a scheme and host. */
export function parseShortUrl(code) {
  const m = typeof code === 'string' ? code.trim().match(SHORT_URL) : null;
  if (!m) return null;
  const id = positiveInt(m[2]);
  return id ? { t: m[1].toLowerCase(), id } : null;
}

// ─── EAN / UPC equivalence ────────────────────────────────────────────────────

/**
 * UPC-E (8 digits: number system 0/1, six data digits, check digit) to the
 * UPC-A it zero-suppresses, or null when the code is not a valid UPC-E.
 * The last data digit says where the zeros go.
 */
export function upcEToUpcA(code) {
  if (typeof code !== 'string' || !/^[01]\d{7}$/.test(code)) return null;
  const [a, b, c, d, e, f] = code.slice(1, 7);
  let body;
  if (f <= '2') body = `${a}${b}${f}0000${c}${d}${e}`; // manufacturer ab f00, product 00cde
  else if (f === '3') body = `${a}${b}${c}00000${d}${e}`; // abc00, 000de
  else if (f === '4') body = `${a}${b}${c}${d}00000${e}`; // abcd0, 0000e
  else body = `${a}${b}${c}${d}${e}0000${f}`; // abcde, 0000f (f 5-9)
  const upcA = `${code[0]}${body}${code[7]}`;
  return validGtinCheckDigit(upcA) ? upcA : null;
}

/** The UPC-E of a UPC-A that zero-suppresses, else null (inverse of upcEToUpcA). */
export function upcAToUpcE(upcA) {
  if (typeof upcA !== 'string' || !/^[01]\d{11}$/.test(upcA)) return null;
  const m = upcA.slice(1, 6);
  const p = upcA.slice(6, 11);
  let data = null;
  if ('012'.includes(m[2]) && m.slice(3) === '00' && p.startsWith('00')) data = `${m[0]}${m[1]}${p.slice(2)}${m[2]}`;
  else if (m.slice(3) === '00' && p.startsWith('000')) data = `${m.slice(0, 3)}${p.slice(3)}3`;
  else if (m[4] === '0' && p.startsWith('0000')) data = `${m.slice(0, 4)}${p[4]}4`;
  else if (p.startsWith('0000') && p[4] >= '5') data = `${m}${p[4]}`;
  if (!data) return null;
  const upcE = `${upcA[0]}${data}${upcA[11]}`;
  return upcEToUpcA(upcE) === upcA ? upcE : null;
}

/**
 * How one numeric read can be stored as an alias:
 *   keys  — GTIN-14 forms (EAN-8 / UPC-A / EAN-13 / GTIN-14 zero-padded; for a
 *           valid UPC-E also its UPC-A), compared with lpad(alias, 14, '0');
 *   forms — the 8-digit UPC-E of the same product, compared as text (padding
 *           a UPC-E does not give its GTIN, so it cannot be a key).
 * An 8-digit read is kept as an EAN-8 too: the digits alone do not say which.
 */
function gtinForms(code) {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return { keys: [], forms: [] };
  const keys = new Set([code.padStart(14, '0')]);
  const upcA = code.length === 8 ? upcEToUpcA(code) : null;
  if (upcA) keys.add(upcA.padStart(14, '0'));
  const forms = new Set();
  for (const key of keys) {
    const upcE = key.startsWith('00') ? upcAToUpcE(key.slice(2)) : null;
    if (upcE) forms.add(upcE);
  }
  return { keys: [...keys], forms: [...forms] };
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

/** Hotels where the user holds grn.read or inventory.read, ascending. */
async function readableHotelIds(t, user) {
  const grn = await hotelIdsWithPermission(t, user, 'grn', 'read');
  const inv = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  return [...new Set([...grn, ...inv])].sort((a, b) => a - b);
}

/**
 * grn.read or inventory.read on one of `hotelIds`. Throws the most telling
 * refusal: FORBIDDEN when the caller could see any of the hotels, else NOT_FOUND.
 */
async function assertReadOnAny(t, user, hotelIds) {
  let refusal = notFound();
  for (const hotelId of hotelIds) {
    for (const resource of ['grn', 'inventory']) {
      try {
        return await assertHotelPermission(t, user, { resource, action: 'read', hotelId });
      } catch (err) {
        if (!(err instanceof InventoryError)) throw err;
        if (err.code === 'FORBIDDEN') refusal = err;
      }
    }
  }
  throw refusal;
}

/** Parse and gate `po:<id>` / `hotel:<id>`; returns where codes resolve. */
async function resolveContext(t, user, context) {
  if (context == null || context === '') {
    const hotels = await readableHotelIds(t, user);
    if (!hotels.length) {
      throw new InventoryError('FORBIDDEN', "You don't have access to inventory at any hotel");
    }
    const rows = await t.any(
      `SELECT DISTINCT hospitality_company_id FROM tbl_hospitality_company_hotels
        WHERE id = ANY($1::int[]) ORDER BY hospitality_company_id`,
      [hotels]
    );
    return { companyIds: rows.map((r) => Number(r.hospitality_company_id)), po: null, hotelId: null };
  }

  const m = typeof context === 'string' ? context.trim().match(/^(po|hotel):(\d+)$/) : null;
  const id = m ? positiveInt(m[2]) : null;
  if (!id) {
    throw new InventoryError('VALIDATION', 'Scan context must be po:<id> or hotel:<id>', { field: 'context' });
  }

  if (m[1] === 'hotel') {
    const { companyId } = await assertReadOnAny(t, user, [id]);
    return { companyIds: [companyId], po: null, hotelId: id };
  }

  let ctx;
  try {
    ctx = await getPoContext(t, id);
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') throw notFound();
    throw err;
  }
  if (!ctx.companyId || !ctx.hotelIds.length) throw notFound();
  await assertReadOnAny(t, user, ctx.hotelIds);
  return { companyIds: [ctx.companyId], po: { id, companyId: ctx.companyId }, hotelId: null };
}

/**
 * The PO is visible to the user: a grn/inventory read grant on one of its
 * hotels (the storekeeper at the receiving bay), or ordinary PO read access
 * (assertPoAccess: awarding / rfq / boq read on the PO's tuple).
 */
async function canSeePo(t, user, poId, readable) {
  let ctx;
  try {
    ctx = await getPoContext(t, poId);
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
  if (ctx.hotelIds.some((h) => readable.includes(h))) return ctx;
  try {
    await assertPoAccess(user, poId, t);
    return ctx;
  } catch (err) {
    if (err?.name === 'PoAccessError') return null;
    throw err;
  }
}

/**
 * Find a short-link target inside the user's scope.
 * @returns {Promise<null|{path:string, kind:string, poId?:number, grnId?:number,
 *   dispatchId?:number, invItemId?:number, companyId?:number}>}
 */
async function locate(t, user, kind, id) {
  if (isOutsider(user) || !id) return null;

  if (kind === 'p') {
    const readable = await readableHotelIds(t, user);
    const ctx = await canSeePo(t, user, id, readable);
    return ctx ? { kind: 'po', poId: id, path: inventoryPoDeliveries(id) } : null;
  }

  if (kind === 'g') {
    const grn = await t.oneOrNone(`SELECT id, hotel_id, po_id FROM tbl_grn WHERE id = $1`, [id]);
    if (!grn) return null;
    const hotels = await hotelIdsWithPermission(t, user, 'grn', 'read');
    if (!hotels.includes(Number(grn.hotel_id))) return null;
    return { kind: 'grn', grnId: id, poId: Number(grn.po_id), path: inventoryGrn(id) };
  }

  if (kind === 'd') {
    const d = await t.oneOrNone(`SELECT id, po_id, hotel_id FROM tbl_po_dispatch WHERE id = $1`, [id]);
    if (!d) return null;
    const poId = Number(d.po_id);
    let candidates = d.hotel_id == null ? null : [Number(d.hotel_id)];
    if (!candidates) {
      try {
        candidates = (await getPoContext(t, poId)).hotelIds;
      } catch (err) {
        if (err instanceof InventoryError && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    }
    const hotels = await hotelIdsWithPermission(t, user, 'grn', 'read');
    if (!candidates.some((h) => hotels.includes(h))) return null;
    return {
      kind: 'dispatch',
      dispatchId: id,
      poId,
      path: `/dashboard/buyer/inventory/receive/${poId}?dispatch=${id}`,
    };
  }

  if (kind === 'i') {
    const item = await t.oneOrNone(
      `SELECT id, hospitality_company_id FROM tbl_inv_item WHERE id = $1`,
      [id]
    );
    if (!item) return null;
    const companyId = Number(item.hospitality_company_id);
    // Scanning our own label is part of receiving, so GRN rights are enough
    // to resolve it; the stock card the link opens needs inventory.read.
    const stockHotels = await hotelIdsWithPermission(t, user, 'inventory', 'read');
    const scanHotels = [...new Set([
      ...stockHotels,
      ...(await hotelIdsWithPermission(t, user, 'grn', 'read')),
      ...(await hotelIdsWithPermission(t, user, 'grn', 'create')),
    ])];
    const inCompany = scanHotels.length
      ? (await t.any(
        `SELECT id FROM tbl_hospitality_company_hotels
          WHERE id = ANY($1::int[]) AND hospitality_company_id = $2 ORDER BY id`,
        [scanHotels, companyId]
      )).map((r) => Number(r.id))
      : [];
    if (!inCompany.length) return null;
    const stockCardHotel = inCompany.find((h) => stockHotels.includes(h));
    return {
      kind: 'item',
      invItemId: id,
      companyId,
      path: stockCardHotel ? `/dashboard/buyer/inventory/stock/${stockCardHotel}/${id}` : null,
    };
  }

  return null;
}

// ─── Item lookup ──────────────────────────────────────────────────────────────

// Stock items on a PO's lines (the line's own variant, else its RFQ product's).
// `$<poId>` is NULL outside a PO context, which lets every item through.
const ON_CONTEXT_PO = (column, param) => `($${param}::int IS NULL OR ${column} IN (
          SELECT iv_po.inv_item_id
            FROM tbl_purchase_order_product pop
            LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
            JOIN tbl_inv_item_variant iv_po
              ON iv_po.product_variant_id = COALESCE(pop.product_variant_id, rp.product_variant_id)
           WHERE pop.purchase_order_id = $${param}))`;

/**
 * Steps 3-5: alias, item code, variant SKU. In a PO context only items on the
 * PO's lines are candidates, so a closer match off the PO cannot hide the one
 * on it. Returns {invItemId, packFactor} or null.
 */
async function lookupItem(t, ctx, code) {
  const { companyIds } = ctx;
  const poId = ctx.po ? ctx.po.id : null;
  const { keys, forms } = gtinForms(code);
  const alias = await t.oneOrNone(
    `SELECT b.inv_item_id, b.pack_factor::text AS pack_factor
       FROM tbl_inv_item_barcode b
      WHERE b.hospitality_company_id = ANY($1::int[])
        AND (b.code = $2
             OR lower(b.code) = lower($2)
             OR b.code = ANY($4::text[])
             OR (b.code ~ '^([0-9]{8}|[0-9]{12,14})$' AND lpad(b.code, 14, '0') = ANY($3::text[])))
        AND ${ON_CONTEXT_PO('b.inv_item_id', 5)}
      ORDER BY (b.code = $2) DESC, (lower(b.code) = lower($2)) DESC, b.id
      LIMIT 1`,
    [companyIds, code, keys, forms, poId]
  );
  if (alias) return { invItemId: Number(alias.inv_item_id), packFactor: Number(alias.pack_factor) };

  const coded = await t.oneOrNone(
    `SELECT id FROM tbl_inv_item
      WHERE hospitality_company_id = ANY($1::int[]) AND item_code IS NOT NULL
        AND lower(item_code) = lower($2)
        AND ${ON_CONTEXT_PO('id', 3)}
      ORDER BY id LIMIT 1`,
    [companyIds, code, poId]
  );
  if (coded) return { invItemId: Number(coded.id), packFactor: 1 };

  const bySku = await t.oneOrNone(
    `SELECT iv.inv_item_id
       FROM tbl_inv_item_variant iv
       JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
      WHERE iv.hospitality_company_id = ANY($1::int[])
        AND COALESCE(pv.is_deleted, 0) = 0
        AND pv.sku IS NOT NULL AND lower(pv.sku) = lower($2)
        AND ${ON_CONTEXT_PO('iv.inv_item_id', 3)}
      ORDER BY iv.id LIMIT 1`,
    [companyIds, code, poId]
  );
  if (bySku) return { invItemId: Number(bySku.inv_item_id), packFactor: 1 };
  return null;
}

/**
 * The item as the scan screens need it, or null when it is outside the
 * context (another company, or not on the context PO).
 */
async function itemPayload(t, { invItemId, packFactor }, ctx) {
  const item = await t.oneOrNone(
    `SELECT id, hospitality_company_id, display_name, stock_uom FROM tbl_inv_item WHERE id = $1`,
    [invItemId]
  );
  if (!item || !ctx.companyIds.includes(Number(item.hospitality_company_id))) return null;

  let poLineId = null;
  if (ctx.po) {
    // The PO line whose variant maps to this item; an open line before a
    // received or short-closed one when the item sits on several lines.
    const line = await t.oneOrNone(
      `SELECT pop.id
         FROM tbl_purchase_order_product pop
         LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
         JOIN tbl_inv_item_variant iv
           ON iv.product_variant_id = COALESCE(pop.product_variant_id, rp.product_variant_id)
          AND iv.hospitality_company_id = $3
        WHERE pop.purchase_order_id = $1 AND iv.inv_item_id = $2
        ORDER BY (pop.receipt_status IN ('received', 'short_closed')), pop.id
        LIMIT 1`,
      [ctx.po.id, invItemId, ctx.po.companyId]
    );
    if (!line) return null;
    poLineId = Number(line.id);
  }

  // In a hotel context: does the hotel hold or plan to hold this item (a
  // balance row or a hotel-item row)? The code is known either way; the
  // screen decides what an unstocked item means. Null without a single hotel.
  let stockedAtHotel = null;
  if (ctx.hotelId) {
    const row = await t.one(
      `SELECT EXISTS (SELECT 1 FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = $2)
           OR EXISTS (SELECT 1 FROM tbl_inv_hotel_item WHERE hotel_id = $1 AND inv_item_id = $2) AS stocked`,
      [ctx.hotelId, invItemId]
    );
    stockedAtHotel = row.stocked === true;
  }

  return {
    invItemId: Number(item.id),
    displayName: item.display_name,
    stockUom: item.stock_uom,
    packFactor,
    poLineId,
    stockedAtHotel,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a scanned or typed code inside the caller's scope.
 *
 * @param {object} t   connection or transaction (reads only)
 * @param {object} user req.user
 * @param {{code:string, context?:string}} args  context 'po:<id>' | 'hotel:<id>'
 * @returns {Promise<{kind:'item'|'po'|'grn'|'dispatch'|'unknown', code:string,
 *   gs1:{gtin,batch,expiry,serial}|null,
 *   item:{invItemId, displayName, stockUom, packFactor:number, poLineId:number|null,
 *         stockedAtHotel:boolean|null}|null,
 *   poId?:number, grnId?:number, dispatchId?:number}>}
 *   `code` is echoed as received (trimmed).
 * @throws InventoryError VALIDATION (code / context), NOT_FOUND (foreign or
 *   missing context, vendor / token user), FORBIDDEN (visible context without
 *   grn.read or inventory.read; no readable hotel at all without a context).
 */
export async function resolveScan(t, user, { code, context } = {}) {
  if (isOutsider(user)) throw notFound();
  const raw = typeof code === 'string' ? code.replace(/^[\s]+|[\r\n\t ]+$/g, '') : '';
  if (!raw) throw new InventoryError('VALIDATION', 'Scan or type a code', { field: 'code' });
  if (raw.length > MAX_CODE_LENGTH) {
    throw new InventoryError('VALIDATION', 'That code is too long', { field: 'code' });
  }

  const ctx = await resolveContext(t, user, context);
  const unknown = (gs1 = null) => ({ kind: 'unknown', code: raw, gs1, item: null });

  // 1. Our own QR.
  const short = parseShortUrl(raw);
  if (short) {
    const found = await locate(t, user, short.t, short.id);
    if (!found) return unknown();
    if (found.kind === 'item') {
      const item = await itemPayload(t, { invItemId: found.invItemId, packFactor: 1 }, ctx);
      return item ? { kind: 'item', code: raw, gs1: null, item } : unknown();
    }
    const out = { kind: found.kind, code: raw, gs1: null, item: null, poId: found.poId };
    if (found.grnId) out.grnId = found.grnId;
    if (found.dispatchId) out.dispatchId = found.dispatchId;
    return out;
  }

  // 2. GS1, else 3-5 on the plain code.
  const gs1 = parseGs1(raw);
  const lookupCode = gs1 ? gs1.gtin : raw.replace(ANY_AIM_PREFIX, '');
  const hit = lookupCode ? await lookupItem(t, ctx, lookupCode) : null;
  const item = hit ? await itemPayload(t, hit, ctx) : null;
  return item ? { kind: 'item', code: raw, gs1, item } : unknown(gs1);
}

/**
 * The frontend route a short link opens, inside the caller's scope.
 *   p → /dashboard/buyer/purchase-orders/<id>?tab=deliveries
 *   g → /dashboard/buyer/inventory/grn/<id>
 *   i → /dashboard/buyer/inventory/stock/<first hotel with inventory.read>/<id>
 *       (404 without inventory.read in the item's company, even though GRN
 *       rights are enough for resolveScan to recognise the same label)
 *   d → /dashboard/buyer/inventory/receive/<poId>?dispatch=<id>
 *
 * @param {object} t
 * @param {object} user req.user
 * @param {{t:string, id:number|string}} args
 * @returns {Promise<{path:string}>}
 * @throws InventoryError NOT_FOUND for a bad kind or id, a missing record, or
 *   one outside the caller's scope (never 403: a link reveals nothing).
 */
export async function resolveShortLink(t, user, { t: kind, id } = {}) {
  const type = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  const found = ['p', 'g', 'i', 'd'].includes(type)
    ? await locate(t, user, type, positiveInt(id))
    : null;
  if (!found || !found.path) throw notFound();
  return { path: found.path };
}

export default { parseGs1, parseShortUrl, upcEToUpcA, upcAToUpcE, resolveScan, resolveShortLink };
