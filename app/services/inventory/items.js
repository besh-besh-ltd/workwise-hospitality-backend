// Stock items and their catalogue variants (spec §5.1).
//
// tbl_inv_item is the company's own stock item. Catalogue variants map onto it
// through tbl_inv_item_variant, unique per (company, variant): one variant maps
// to one item, but several variants may share an item (the catalogue has
// duplicate and "shadow" variants, RFQ 536273). Mapping is forward-only.
//
// The first receipt of an unmapped variant creates a 1:1 item lazily: the
// variant's name, the PO line's unit as stock unit, and expiry tracking from
// the company's category defaults. Before that, the receiver can be offered
// "Is this the same as …?" suggestions (suggestItems) and map instead.
//
// Every function takes the caller's transaction `t` and a TRUSTED companyId
// (derived from the PO / hotel row, never from the request).

import { InventoryError } from './errors.js';
import { normalizeUomLabel } from './uom.js';

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function requireId(value, field, label) {
  const id = positiveInt(value);
  if (!id) throw new InventoryError('VALIDATION', `Invalid ${label}`, { field });
  return id;
}

const ITEM_COLUMNS = `i.id, i.display_name, i.stock_uom, i.track_expiry, i.min_shelf_life_days,
                      i.over_receipt_tolerance_pct::text AS over_receipt_tolerance_pct`;

const toItem = (row, created) => ({
  id: Number(row.id),
  displayName: row.display_name,
  stockUom: row.stock_uom,
  trackExpiry: row.track_expiry === true,
  minShelfLifeDays: row.min_shelf_life_days == null ? null : Number(row.min_shelf_life_days),
  overReceiptTolerancePct: row.over_receipt_tolerance_pct == null ? null : Number(row.over_receipt_tolerance_pct),
  created,
});

async function mappedItem(t, companyId, productVariantId) {
  return t.oneOrNone(
    `SELECT ${ITEM_COLUMNS}
       FROM tbl_inv_item_variant iv
       JOIN tbl_inv_item i ON i.id = iv.inv_item_id AND i.hospitality_company_id = iv.hospitality_company_id
      WHERE iv.hospitality_company_id = $1 AND iv.product_variant_id = $2`,
    [companyId, productVariantId]
  );
}

/**
 * Serialises lazy creation and mapping of one (company, variant) inside the
 * caller's transaction, so two concurrent first receipts of the same variant
 * create one item, not two. Released at commit / rollback.
 */
async function lockVariant(t, companyId, productVariantId) {
  // One row (void) comes back, hence t.one, not t.none.
  await t.one(`SELECT pg_advisory_xact_lock(hashtext('inv:item_variant:' || $1::text), $2::int)`, [
    companyId,
    productVariantId,
  ]);
}

/**
 * The company's stock item for a catalogue variant, creating it lazily.
 *
 * @param {object} t transaction
 * @param {{companyId:number, productVariantId:number, createIfMissing?:boolean,
 *          userId?:number|null, defaultUom?:string}} args
 *   defaultUom: the PO line's unit, used as the stock unit of a new item
 *   (stored trimmed with whitespace collapsed).
 * @returns {Promise<{id, displayName, stockUom, trackExpiry, minShelfLifeDays,
 *   overReceiptTolerancePct, created:boolean}|null>} null when unmapped and
 *   createIfMissing is false.
 * @throws InventoryError VALIDATION (companyId | productVariantId | defaultUom),
 *   NOT_FOUND when the variant does not exist (create only).
 */
export async function resolveItemForVariant(
  t,
  { companyId, productVariantId, createIfMissing = false, userId = null, defaultUom } = {}
) {
  const company = requireId(companyId, 'companyId', 'company');
  const variant = requireId(productVariantId, 'productVariantId', 'product variant');

  const existing = await mappedItem(t, company, variant);
  if (existing) return toItem(existing, false);
  if (!createIfMissing) return null;

  const stockUom = normalizeUomLabel(defaultUom);
  if (!stockUom) {
    throw new InventoryError('VALIDATION', 'A stock unit is required to create the item', { field: 'defaultUom' });
  }
  if (stockUom.length > 99) {
    throw new InventoryError('VALIDATION', 'The stock unit is too long', { field: 'defaultUom' });
  }

  await lockVariant(t, company, variant);
  const raced = await mappedItem(t, company, variant);
  if (raced) return toItem(raced, false);

  // Expiry tracking: true when ANY of the variant's categories, or any of
  // their ancestors, has a company default with track_expiry (e.g. Dairy >
  // Milk). The ancestor walk is bounded against cyclic category data.
  const source = await t.oneOrNone(
    `WITH RECURSIVE cats AS (
       SELECT pc.category_id AS id, 1 AS depth
         FROM tbl_product_variant pv
         JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
        WHERE pv.id = $2 AND pc.category_id IS NOT NULL
       UNION
       SELECT c.parent_id, cats.depth + 1
         FROM cats JOIN tbl_category c ON c.id = cats.id
        WHERE c.parent_id IS NOT NULL AND c.parent_id > 0 AND cats.depth < 6
     )
     SELECT pv.id,
            COALESCE(NULLIF(btrim(pv.name), ''), 'Item ' || pv.id) AS display_name,
            EXISTS (SELECT 1 FROM tbl_inv_category_default cd
                     WHERE cd.hospitality_company_id = $1
                       AND cd.track_expiry
                       AND cd.category_id IN (SELECT id FROM cats)) AS track_expiry
       FROM tbl_product_variant pv
      WHERE pv.id = $2`,
    [company, variant]
  );
  if (!source) throw new InventoryError('NOT_FOUND', 'Product not found', { productVariantId: variant });

  const item = await t.one(
    `INSERT INTO tbl_inv_item
       (hospitality_company_id, display_name, stock_uom, track_expiry, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, display_name, stock_uom, track_expiry, min_shelf_life_days,
               over_receipt_tolerance_pct::text AS over_receipt_tolerance_pct`,
    [company, String(source.display_name).slice(0, 255), stockUom, source.track_expiry === true, userId ?? null]
  );
  await t.none(
    `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id, created_by)
     VALUES ($1, $2, $3, $4)`,
    [company, item.id, variant, userId ?? null]
  );
  return toItem(item, true);
}

/**
 * Map a catalogue variant onto an existing item of the same company.
 * Idempotent for the same item; forward-only otherwise.
 *
 * @returns {Promise<{invItemId:number, productVariantId:number, created:boolean}>}
 *   created=false when the variant was already mapped to this item.
 * @throws InventoryError
 *   VALIDATION (companyId | productVariantId | invItemId; inactive item),
 *   NOT_FOUND  item not in this company, or variant missing,
 *   CONFLICT   variant already mapped to a different item
 *              (details {productVariantId, invItemId: current, requestedInvItemId}).
 */
export async function mapVariantToItem(t, { companyId, productVariantId, invItemId, userId = null } = {}) {
  const company = requireId(companyId, 'companyId', 'company');
  const variant = requireId(productVariantId, 'productVariantId', 'product variant');
  const itemId = requireId(invItemId, 'invItemId', 'item');

  const item = await t.oneOrNone(
    `SELECT id, is_active FROM tbl_inv_item WHERE id = $1 AND hospitality_company_id = $2`,
    [itemId, company]
  );
  if (!item) throw new InventoryError('NOT_FOUND', 'Item not found', { invItemId: itemId });
  if (!item.is_active) {
    throw new InventoryError('VALIDATION', 'The item is inactive', { field: 'invItemId', invItemId: itemId });
  }
  const exists = await t.oneOrNone(`SELECT id FROM tbl_product_variant WHERE id = $1`, [variant]);
  if (!exists) throw new InventoryError('NOT_FOUND', 'Product not found', { productVariantId: variant });

  await lockVariant(t, company, variant);
  const inserted = await t.oneOrNone(
    `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hospitality_company_id, product_variant_id) DO NOTHING
     RETURNING id`,
    [company, itemId, variant, userId ?? null]
  );
  if (inserted) return { invItemId: itemId, productVariantId: variant, created: true };

  const current = await t.one(
    `SELECT iv.inv_item_id, i.display_name
       FROM tbl_inv_item_variant iv JOIN tbl_inv_item i ON i.id = iv.inv_item_id
      WHERE iv.hospitality_company_id = $1 AND iv.product_variant_id = $2`,
    [company, variant]
  );
  if (Number(current.inv_item_id) === itemId) {
    return { invItemId: itemId, productVariantId: variant, created: false };
  }
  throw new InventoryError(
    'CONFLICT',
    `This product is already mapped to "${current.display_name}"`,
    { productVariantId: variant, invItemId: Number(current.inv_item_id), requestedInvItemId: itemId }
  );
}

const SUGGEST_LIMIT = 5;
const SUGGEST_MIN_SCORE = 0.3;

async function hasTrigram(t) {
  const row = await t.one(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok`);
  return row.ok === true;
}

/** The variant's name (display form) and the item it already maps to, if any. */
async function variantForSuggestions(t, companyId, productVariantId) {
  const company = requireId(companyId, 'companyId', 'company');
  const variant = requireId(productVariantId, 'productVariantId', 'product variant');
  const v = await t.oneOrNone(
    `SELECT pv.name,
            (SELECT iv.inv_item_id FROM tbl_inv_item_variant iv
              WHERE iv.hospitality_company_id = $1 AND iv.product_variant_id = pv.id) AS own_item_id
       FROM tbl_product_variant pv WHERE pv.id = $2`,
    [company, variant]
  );
  return {
    company,
    name: normalizeUomLabel(v?.name), // same trim + collapse
    ownItemId: v?.own_item_id == null ? null : Number(v.own_item_id),
  };
}

const toSuggestions = (rows) =>
  rows.map((r) => ({
    invItemId: Number(r.id),
    displayName: r.display_name,
    score: Math.round(Number(r.score) * 1000) / 1000,
  }));

/**
 * "Is this the same as …?" candidates for a variant: active items of the
 * company whose name resembles the variant's, best first, at most 5, score
 * ≥ 0.3, never the item the variant is already mapped to.
 *
 * Uses pg_trgm similarity() when the extension is installed (it is, in every
 * environment today), else suggestItemsByWords.
 *
 * @returns {Promise<Array<{invItemId:number, displayName:string, score:number}>>}
 *   score in [0.3, 1], 3 dp.
 */
export async function suggestItems(t, { companyId, productVariantId } = {}) {
  if (!(await hasTrigram(t))) return suggestItemsByWords(t, { companyId, productVariantId });
  const { company, name, ownItemId } = await variantForSuggestions(t, companyId, productVariantId);
  if (!name) return [];
  const rows = await t.any(
    `SELECT id, display_name, similarity(display_name, $2)::float8 AS score
       FROM tbl_inv_item
      WHERE hospitality_company_id = $1 AND is_active
        AND ($3::int IS NULL OR id <> $3)
        AND similarity(display_name, $2) >= $4
      ORDER BY score DESC, id
      LIMIT $5`,
    [company, name, ownItemId, SUGGEST_MIN_SCORE, SUGGEST_LIMIT]
  );
  return toSuggestions(rows);
}

/**
 * suggestItems without pg_trgm: score = the share of the variant name's words
 * (2+ characters) found in the item name, case-insensitively (ILIKE per word).
 * Same filters, limit and threshold.
 */
export async function suggestItemsByWords(t, { companyId, productVariantId } = {}) {
  const { company, name, ownItemId } = await variantForSuggestions(t, companyId, productVariantId);
  const words = [...new Set(name.toLowerCase().split(' ').filter((w) => w.length >= 2))];
  if (!words.length) return [];
  // Escape LIKE wildcards in each word.
  const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const rows = await t.any(
    `SELECT id, display_name, score FROM (
       SELECT i.id, i.display_name,
              (SELECT COUNT(*) FROM unnest($2::text[]) p WHERE i.display_name ILIKE p)::float8
                / $3::float8 AS score
         FROM tbl_inv_item i
        WHERE i.hospitality_company_id = $1 AND i.is_active
          AND ($4::int IS NULL OR i.id <> $4)
     ) s
     WHERE score >= $5
     ORDER BY score DESC, id
     LIMIT $6`,
    [company, patterns, words.length, ownItemId, SUGGEST_MIN_SCORE, SUGGEST_LIMIT]
  );
  return toSuggestions(rows);
}

export default { resolveItemForVariant, mapVariantToItem, suggestItems, suggestItemsByWords };
