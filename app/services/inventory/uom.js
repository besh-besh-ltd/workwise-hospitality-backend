// Unit conversion between a PO line's free-text unit and an item's stock unit
// (spec §6.7).
//
// PO units are free text (tbl_purchase_order_product.unit), so "KG ", "kg" and
// "Kg" must all mean the same unit. Labels are compared normalised: trimmed,
// runs of whitespace collapsed to one space, case-folded. A label equal to the
// stock unit converts at 1; otherwise tbl_inv_item_uom holds the factor; with
// neither, the answer is null and the caller blocks the receipt. There is no
// silent factor-1 fallback (Review Focus 2).

import { InventoryError } from './errors.js';

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Display form of a unit label: trimmed, inner whitespace collapsed, case kept. */
export function normalizeUomLabel(label) {
  if (label == null) return '';
  return String(label).trim().replace(/\s+/g, ' ');
}

/** Comparison key of a unit label: the display form, case-folded. */
export const uomKey = (label) => normalizeUomLabel(label).toLowerCase();

/** True when two unit labels name the same unit. */
export const sameUom = (a, b) => uomKey(a) === uomKey(b);

async function loadItem(t, invItemId) {
  const id = positiveInt(invItemId);
  if (!id) throw new InventoryError('VALIDATION', 'Invalid item', { field: 'invItemId' });
  const item = await t.oneOrNone(
    `SELECT id, hospitality_company_id, stock_uom FROM tbl_inv_item WHERE id = $1`,
    [id]
  );
  if (!item) throw new InventoryError('NOT_FOUND', 'Item not found', { invItemId: id });
  return item;
}

/**
 * How many stock units one `uomLabel` holds for this item.
 *
 * @returns {Promise<number|null>} 1 when the label is the stock unit, the
 *   tbl_inv_item_uom factor when one is defined, else null (unknown unit).
 * @throws InventoryError NOT_FOUND when the item does not exist.
 */
export async function resolveUomFactor(t, { invItemId, uomLabel } = {}) {
  const item = await loadItem(t, invItemId);
  const key = uomKey(uomLabel);
  if (!key) return null;
  if (key === uomKey(item.stock_uom)) return 1;
  return pickFactor(await uomRows(t, [item.id]), key);
}

/** An item's defined conversions, in id order (the first match wins). */
async function uomRows(t, invItemIds) {
  return t.any(
    `SELECT inv_item_id, uom_label, factor_to_stock::text AS factor
       FROM tbl_inv_item_uom WHERE inv_item_id = ANY($1::int[]) ORDER BY id`,
    [invItemIds]
  );
}

// Compared in JS with the same normaliser, so a label stored before
// normalisation (e.g. by hand) still matches.
function pickFactor(rows, key) {
  const hit = rows.find((r) => uomKey(r.uom_label) === key);
  return hit ? Number(hit.factor) : null;
}

/**
 * resolveUomFactor for many items at once (the Receive screen): one query for
 * all their conversions. Items are passed in already loaded.
 *
 * @param {object} t
 * @param {Array<{id:number|string, stock_uom:string}>} items
 * @returns {Promise<(invItemId:number, uomLabel:string) => number|null>} the
 *   same answer resolveUomFactor gives for that item and label.
 */
export async function uomFactorLookup(t, items) {
  const stockUom = new Map(items.map((i) => [Number(i.id), i.stock_uom]));
  const byItem = new Map();
  for (const r of stockUom.size ? await uomRows(t, [...stockUom.keys()]) : []) {
    const id = Number(r.inv_item_id);
    if (!byItem.has(id)) byItem.set(id, []);
    byItem.get(id).push(r);
  }
  return (invItemId, uomLabel) => {
    const id = Number(invItemId);
    const key = uomKey(uomLabel);
    if (!key) return null;
    if (key === uomKey(stockUom.get(id))) return 1;
    return pickFactor(byItem.get(id) || [], key);
  };
}

/**
 * Define (or redefine) how many stock units one `uomLabel` holds.
 *
 * The label is stored in display form (trimmed, whitespace collapsed, case
 * kept); the unique index is on (inv_item_id, lower(uom_label)), so "CASE"
 * after "Case" updates the same row (label and factor).
 *
 * @returns {Promise<{id:number, invItemId:number, uomLabel:string, factor:number}>}
 * @throws InventoryError VALIDATION (field uomLabel | factor | invItemId),
 *   NOT_FOUND when the item does not exist.
 */
export async function setUomFactor(t, { invItemId, uomLabel, factor, userId = null } = {}) {
  const item = await loadItem(t, invItemId);
  const label = normalizeUomLabel(uomLabel);
  if (!label) throw new InventoryError('VALIDATION', 'A unit name is required', { field: 'uomLabel' });
  if (label.length > 99) throw new InventoryError('VALIDATION', 'The unit name is too long', { field: 'uomLabel' });
  if (sameUom(label, item.stock_uom)) {
    throw new InventoryError(
      'VALIDATION',
      `"${label}" is the item's stock unit; it always converts at 1`,
      { field: 'uomLabel', stockUom: item.stock_uom }
    );
  }
  const f = typeof factor === 'string' && factor.trim() !== '' ? Number(factor) : factor;
  if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) {
    throw new InventoryError('VALIDATION', 'The conversion factor must be a number greater than 0', { field: 'factor' });
  }
  const rounded = Math.round(f * 1e6) / 1e6; // factor_to_stock is NUMERIC(18,6)
  if (rounded <= 0) {
    throw new InventoryError('VALIDATION', 'The conversion factor is too small', { field: 'factor' });
  }

  const row = await t.one(
    `INSERT INTO tbl_inv_item_uom
       (hospitality_company_id, inv_item_id, uom_label, factor_to_stock, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (inv_item_id, lower(uom_label)) DO UPDATE
        SET uom_label = EXCLUDED.uom_label,
            factor_to_stock = EXCLUDED.factor_to_stock,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
     RETURNING id, inv_item_id, uom_label, factor_to_stock::text AS factor`,
    [item.hospitality_company_id, item.id, label, rounded, userId ?? null]
  );
  return { id: Number(row.id), invItemId: Number(row.inv_item_id), uomLabel: row.uom_label, factor: Number(row.factor) };
}

export default { resolveUomFactor, uomFactorLookup, setUomFactor, normalizeUomLabel, uomKey, sameUom };
