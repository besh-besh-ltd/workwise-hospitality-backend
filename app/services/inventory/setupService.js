// Admin side of the inventory module (Task B3): stock items, units, barcodes,
// per-hotel levels, company/hotel settings and category defaults.
//
// Tenancy: nothing here reads a company or hotel id from the request body.
//   - Item routes load the item first and derive the company from its row.
//     A company the caller has no footing in is NOT_FOUND; one they belong to
//     but lack the permission in is FORBIDDEN.
//   - Hotel routes go through assertHotelPermission (company comes from the hotel).
//   - Company-level routes without an entity (create item, settings, category
//     defaults, suggestions) use the companies where the caller holds the
//     permission on ANY hotel. With several, an optional hint (query / header)
//     may only NARROW to one of those; it never widens.
//
// Every mutating function returns { result, audit } where audit is
// { companyId, hotelId?, label } for res.locals.activityDetail.

import { InventoryError } from './errors.js';
import { assertHotelPermission, hotelIdsWithPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { resolveItemForVariant, mapVariantToItem as mapVariant, suggestItems as suggest } from './items.js';
import { setUomFactor, normalizeUomLabel, uomKey } from './uom.js';

export const PAGE_SIZE = 50;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isSuperAdmin = (user) => Number(user?.user_type) === 8;

function bad(message, field, extra = {}) {
  return new InventoryError('VALIDATION', message, { field, ...extra });
}

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const numOrNull = (v) => (v == null ? null : Number(v));
const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// ───────────────────────── scope helpers ─────────────────────────

/** Companies where the user holds inventory.<action> on at least one hotel. */
async function companiesWith(t, user, action) {
  const hotels = await hotelIdsWithPermission(t, user, 'inventory', action);
  if (!hotels.length) return [];
  const rows = await t.any(
    `SELECT DISTINCT hospitality_company_id FROM tbl_hospitality_company_hotels
      WHERE id = ANY($1::int[]) AND COALESCE(is_deleted, 0) = 0
      ORDER BY hospitality_company_id`,
    [hotels]
  );
  return rows.map((r) => Number(r.hospitality_company_id));
}

async function isMemberOfCompany(t, user, companyId) {
  if (isSuperAdmin(user)) return true;
  const userId = positiveInt(user?.id);
  if (!userId) return false;
  const row = await t.one(
    `SELECT (EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings m
                      WHERE m.user_id = $1 AND m.hospitality_company_id = $2)
          OR EXISTS (SELECT 1 FROM tbl_user_role_scopes s
                      WHERE s.user_id = $1 AND s.company_id = $2)) AS member`,
    [userId, companyId]
  );
  return row.member === true;
}

/**
 * The company an entity-less request acts on. `hint` can only choose among the
 * companies the caller already holds the permission in.
 */
async function resolveCompany(t, user, action, hint = null) {
  let companies = await companiesWith(t, user, action);
  if (!companies.length) {
    throw new InventoryError('FORBIDDEN', "You don't have permission to do this", {
      resource: 'inventory',
      action,
    });
  }
  const hinted = positiveInt(hint);
  if (hinted != null) companies = companies.filter((c) => c === hinted);
  if (companies.length === 1) return companies[0];
  if (!companies.length) {
    throw new InventoryError('FORBIDDEN', "You don't have permission to do this in that company", {
      resource: 'inventory',
      action,
    });
  }
  throw bad('Choose which company this is for', 'companyId');
}

/** Item by id, visible only inside a company where the caller holds `action`. */
async function loadItem(t, user, itemId, action, { forUpdate = false } = {}) {
  const id = positiveInt(itemId);
  if (!id) throw new InventoryError('NOT_FOUND', 'Item not found');
  const item = await t.oneOrNone(
    `SELECT * FROM tbl_inv_item WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id]
  );
  if (!item) throw new InventoryError('NOT_FOUND', 'Item not found');
  const companyId = Number(item.hospitality_company_id);
  if ((await companiesWith(t, user, action)).includes(companyId)) return item;
  if (action !== 'read' && (await isMemberOfCompany(t, user, companyId))) {
    throw new InventoryError('FORBIDDEN', "You don't have permission to do this", {
      resource: 'inventory',
      action,
    });
  }
  throw new InventoryError('NOT_FOUND', 'Item not found');
}

// ───────────────────────── item DTO ─────────────────────────

async function itemDtos(t, itemRows) {
  if (!itemRows.length) return [];
  const ids = itemRows.map((r) => Number(r.id));
  const [variants, barcodes] = await Promise.all([
    t.any(
      `SELECT iv.inv_item_id, iv.product_variant_id, COALESCE(pv.name, 'Variant ' || pv.id) AS name
         FROM tbl_inv_item_variant iv
         JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
        WHERE iv.inv_item_id = ANY($1::int[])
        ORDER BY iv.id`,
      [ids]
    ),
    t.any(
      `SELECT id, inv_item_id, code, pack_factor::text AS pack_factor, source
         FROM tbl_inv_item_barcode WHERE inv_item_id = ANY($1::int[]) ORDER BY id`,
      [ids]
    ),
  ]);
  return itemRows.map((r) => ({
    id: Number(r.id),
    displayName: r.display_name,
    itemCode: r.item_code,
    stockUom: r.stock_uom,
    trackExpiry: r.track_expiry === true,
    minShelfLifeDays: numOrNull(r.min_shelf_life_days),
    overReceiptTolerancePct: numOrNull(r.over_receipt_tolerance_pct),
    isActive: r.is_active === true,
    variants: variants
      .filter((v) => Number(v.inv_item_id) === Number(r.id))
      .map((v) => ({ productVariantId: Number(v.product_variant_id), name: v.name })),
    barcodes: barcodes
      .filter((b) => Number(b.inv_item_id) === Number(r.id))
      .map((b) => ({ id: Number(b.id), code: b.code, packFactor: Number(b.pack_factor), source: b.source })),
  }));
}

const ITEM_SELECT = `SELECT i.id, i.hospitality_company_id, i.display_name, i.item_code, i.stock_uom, i.track_expiry,
       i.min_shelf_life_days, i.over_receipt_tolerance_pct::text AS over_receipt_tolerance_pct, i.is_active
  FROM tbl_inv_item i`;

async function oneItemDto(t, id) {
  const row = await t.one(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  return (await itemDtos(t, [row]))[0];
}

// ───────────────────────── items ─────────────────────────

export async function listItems(t, user, { search, page, hotelId, companyHint } = {}) {
  let companies;
  if (hotelId != null && hotelId !== '') {
    const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'read', hotelId });
    companies = [companyId];
  } else {
    companies = await companiesWith(t, user, 'read');
    const hinted = positiveInt(companyHint);
    if (hinted != null) companies = companies.filter((c) => c === hinted);
  }
  if (!companies.length) return { rows: [], total: 0 };

  const params = [companies];
  let where = 'i.hospitality_company_id = ANY($1::int[])';
  const q = String(search ?? '').trim();
  if (q) {
    params.push(`%${escLike(q)}%`);
    where += ` AND (i.display_name ILIKE $${params.length} OR i.item_code ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM tbl_inv_item_barcode b WHERE b.inv_item_id = i.id AND b.code ILIKE $${params.length})
      OR EXISTS (SELECT 1 FROM tbl_inv_item_variant iv JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
                  WHERE iv.inv_item_id = i.id AND (pv.name ILIKE $${params.length} OR pv.sku ILIKE $${params.length})))`;
  }
  const pageNo = Math.max(1, positiveInt(page) ?? 1);
  const total = Number((await t.one(`SELECT count(*) AS n FROM tbl_inv_item i WHERE ${where}`, params)).n);
  const rows = await t.any(
    `${ITEM_SELECT} WHERE ${where} ORDER BY lower(i.display_name), i.id LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
    params
  );
  return { rows: await itemDtos(t, rows), total };
}

export async function createItem(t, user, body = {}, { companyHint = null } = {}) {
  const variantId = positiveInt(body.productVariantId);
  if (!variantId) throw bad('A product variant is required', 'productVariantId');
  const stockUom = normalizeUomLabel(body.stockUom);
  if (!stockUom) throw bad('A stock unit is required', 'stockUom');
  if (stockUom.length > 99) throw bad('The stock unit is too long', 'stockUom');
  const displayName = body.displayName == null ? null : String(body.displayName).trim();
  if (body.displayName != null && !displayName) throw bad('The name cannot be blank', 'displayName');
  if (displayName && displayName.length > 255) throw bad('The name is too long', 'displayName');
  const minShelf = parseMinShelf(body.minShelfLifeDays);
  if (body.trackExpiry != null && typeof body.trackExpiry !== 'boolean') throw bad('Invalid value', 'trackExpiry');

  // Company: among the companies where the caller is an admin. The catalogue
  // is global, so when the caller admins several and gives no hint, the
  // variant's own mapping decides: the company that already maps it, else the
  // only one that doesn't.
  let candidates = await companiesWith(t, user, 'admin');
  if (!candidates.length) {
    throw new InventoryError('FORBIDDEN', "You don't have permission to do this", {
      resource: 'inventory',
      action: 'admin',
    });
  }
  const hinted = positiveInt(companyHint);
  if (hinted != null) candidates = candidates.filter((c) => c === hinted);
  if (candidates.length > 1) {
    const mapped = await t.any(
      `SELECT hospitality_company_id FROM tbl_inv_item_variant
        WHERE product_variant_id = $1 AND hospitality_company_id = ANY($2::int[])`,
      [variantId, candidates]
    );
    const mappedIn = mapped.map((r) => Number(r.hospitality_company_id));
    if (mappedIn.length) candidates = mappedIn; // none mapped: still ambiguous, reported below
  }
  if (candidates.length !== 1) {
    if (!candidates.length) {
      throw new InventoryError('FORBIDDEN', "You don't have permission to do this in that company", {
        resource: 'inventory',
        action: 'admin',
      });
    }
    throw bad('Choose which company this item is for', 'companyId');
  }
  const companyId = candidates[0];

  const item = await resolveItemForVariant(t, {
    companyId,
    productVariantId: variantId,
    createIfMissing: true,
    userId: user.id,
    defaultUom: stockUom,
  });
  if (!item.created) {
    throw new InventoryError('CONFLICT', `This product is already mapped to the item "${item.displayName}"`, {
      productVariantId: variantId,
      invItemId: item.id,
      displayName: item.displayName,
    });
  }
  await t.none(
    `UPDATE tbl_inv_item
        SET display_name = COALESCE($2, display_name),
            track_expiry = COALESCE($3, track_expiry),
            min_shelf_life_days = $4,
            updated_by = $5, updated_at = now()
      WHERE id = $1`,
    [item.id, displayName ? displayName.slice(0, 255) : null, body.trackExpiry ?? null, minShelf, user.id]
  );
  const dto = await oneItemDto(t, item.id);
  return { result: dto, audit: { companyId, label: dto.displayName } };
}

function parseMinShelf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw bad('Minimum shelf life must be a whole number of days', 'minShelfLifeDays');
  return n;
}

export async function updateItem(t, user, itemId, body = {}) {
  const item = await loadItem(t, user, itemId, 'admin', { forUpdate: true });
  const next = {};

  if (body.displayName !== undefined) {
    const name = String(body.displayName ?? '').trim();
    if (!name) throw bad('The name cannot be blank', 'displayName');
    if (name.length > 255) throw bad('The name is too long', 'displayName');
    next.display_name = name;
  }
  if (body.itemCode !== undefined) {
    const code = body.itemCode == null ? '' : String(body.itemCode).trim();
    if (code.length > 64) throw bad('The item code is too long', 'itemCode');
    next.item_code = code || null;
  }
  if (body.stockUom !== undefined) {
    const uom = normalizeUomLabel(body.stockUom);
    if (!uom) throw bad('A stock unit is required', 'stockUom');
    if (uom.length > 99) throw bad('The stock unit is too long', 'stockUom');
    next.stock_uom = uom;
  }
  if (body.trackExpiry !== undefined) {
    if (typeof body.trackExpiry !== 'boolean') throw bad('Invalid value', 'trackExpiry');
    next.track_expiry = body.trackExpiry;
  }
  if (body.minShelfLifeDays !== undefined) next.min_shelf_life_days = parseMinShelf(body.minShelfLifeDays);
  if (body.overReceiptTolerancePct !== undefined) {
    if (body.overReceiptTolerancePct === null || body.overReceiptTolerancePct === '') {
      next.over_receipt_tolerance_pct = null;
    } else {
      const n = Number(body.overReceiptTolerancePct);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Tolerance must be between 0 and 100', 'overReceiptTolerancePct');
      next.over_receipt_tolerance_pct = n;
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw bad('Invalid value', 'isActive');
    next.is_active = body.isActive;
  }

  // The stock unit is what every balance and movement is counted in: it can
  // change only while the item has no history. Its unit conversions are
  // relative to the old unit, so they go with it.
  if (next.stock_uom && uomKey(next.stock_uom) !== uomKey(item.stock_uom)) {
    const used = await t.one(
      `SELECT (EXISTS (SELECT 1 FROM tbl_inv_movement WHERE inv_item_id = $1)
            OR EXISTS (SELECT 1 FROM tbl_grn_line WHERE inv_item_id = $1)) AS used`,
      [item.id]
    );
    if (used.used) {
      throw new InventoryError('CONFLICT', 'The stock unit cannot change once the item has stock history', {
        field: 'stockUom',
      });
    }
    await t.none(`DELETE FROM tbl_inv_item_uom WHERE inv_item_id = $1`, [item.id]);
  }

  const cols = Object.keys(next);
  if (cols.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    try {
      await t.tx(async (sp) => {
        await sp.none(`UPDATE tbl_inv_item SET ${sets}, updated_by = $2, updated_at = now() WHERE id = $1`, [
          item.id,
          user.id,
          ...cols.map((c) => next[c]),
        ]);
      });
    } catch (err) {
      if (err?.code === '23505' && next.item_code) {
        const other = await t.oneOrNone(
          `SELECT display_name FROM tbl_inv_item
            WHERE hospitality_company_id = $1 AND lower(item_code) = lower($2) AND id <> $3`,
          [item.hospitality_company_id, next.item_code, item.id]
        );
        throw new InventoryError('CONFLICT', `The item code ${next.item_code} is already used by "${other?.display_name ?? 'another item'}"`, {
          field: 'itemCode',
        });
      }
      throw err;
    }
  }
  const dto = await oneItemDto(t, item.id);
  return { result: dto, audit: { companyId: Number(item.hospitality_company_id), label: dto.displayName } };
}

export async function mapVariantToItem(t, user, itemId, body = {}) {
  const item = await loadItem(t, user, itemId, 'admin');
  const productVariantId = positiveInt(body.productVariantId);
  if (!productVariantId) throw bad('A product variant is required', 'productVariantId');
  await mapVariant(t, {
    companyId: Number(item.hospitality_company_id),
    productVariantId,
    invItemId: item.id,
    userId: user.id,
  });
  const dto = await oneItemDto(t, item.id);
  return { result: dto, audit: { companyId: Number(item.hospitality_company_id), label: dto.displayName } };
}

export async function suggestItems(t, user, { productVariantId, companyHint = null } = {}) {
  const variant = positiveInt(productVariantId);
  if (!variant) throw bad('A product variant is required', 'productVariantId');
  const companyId = await resolveCompany(t, user, 'read', companyHint);
  return suggest(t, { companyId, productVariantId: variant });
}

// ───────────────────────── units ─────────────────────────

const toUomRows = (rows) => rows.map((r) => ({ uomLabel: r.uom_label, factorToStock: Number(r.factor_to_stock) }));

async function readUoms(t, itemId) {
  return toUomRows(
    await t.any(
      `SELECT uom_label, factor_to_stock::text AS factor_to_stock FROM tbl_inv_item_uom
        WHERE inv_item_id = $1 ORDER BY lower(uom_label)`,
      [itemId]
    )
  );
}

export async function getItemUoms(t, user, itemId) {
  const item = await loadItem(t, user, itemId, 'read');
  return readUoms(t, item.id);
}

export async function saveItemUoms(t, user, itemId, body = {}) {
  const item = await loadItem(t, user, itemId, 'update');
  if (!Array.isArray(body.uoms)) throw bad('uoms must be a list', 'uoms');
  const seen = new Set();
  for (const u of body.uoms) {
    const key = uomKey(u?.uomLabel);
    if (!key) throw bad('Every unit needs a label', 'uomLabel');
    if (seen.has(key)) throw bad(`The unit "${normalizeUomLabel(u.uomLabel)}" is listed twice`, 'uomLabel');
    seen.add(key);
  }
  for (const u of body.uoms) {
    await setUomFactor(t, { invItemId: item.id, uomLabel: u.uomLabel, factor: u.factorToStock, userId: user.id });
  }
  await t.none(
    `DELETE FROM tbl_inv_item_uom WHERE inv_item_id = $1 AND NOT (lower(uom_label) = ANY($2::text[]))`,
    [item.id, [...seen]]
  );
  return {
    result: await readUoms(t, item.id),
    audit: { companyId: Number(item.hospitality_company_id), label: item.display_name },
  };
}

// ───────────────────────── barcodes ─────────────────────────

export async function addItemBarcode(t, user, itemId, body = {}) {
  const item = await loadItem(t, user, itemId, 'update');
  const code = String(body.code ?? '').trim();
  if (!code) throw bad('A barcode is required', 'code');
  if (code.length > 128) throw bad('The barcode is too long', 'code');
  const packFactor = body.packFactor == null || body.packFactor === '' ? 1 : Number(body.packFactor);
  if (!Number.isFinite(packFactor) || packFactor <= 0) throw bad('Pack size must be greater than 0', 'packFactor');
  const source = body.source == null ? 'MANUFACTURER' : String(body.source);
  if (!['MANUFACTURER', 'INTERNAL'].includes(source)) throw bad('Source must be MANUFACTURER or INTERNAL', 'source');

  const companyId = Number(item.hospitality_company_id);
  const clashError = async () => {
    const clash = await t.oneOrNone(
      `SELECT i.id, i.display_name FROM tbl_inv_item_barcode b JOIN tbl_inv_item i ON i.id = b.inv_item_id
        WHERE b.hospitality_company_id = $1 AND b.code = $2`,
      [companyId, code]
    );
    return new InventoryError('CONFLICT', `The barcode ${code} already belongs to "${clash?.display_name ?? 'another item'}"`, {
      field: 'code',
      invItemId: clash ? Number(clash.id) : null,
      displayName: clash?.display_name ?? null,
    });
  };
  if (await t.oneOrNone(`SELECT 1 FROM tbl_inv_item_barcode WHERE hospitality_company_id = $1 AND code = $2`, [companyId, code])) {
    throw await clashError();
  }
  let row;
  try {
    // savepoint, so a concurrent duplicate does not abort the caller's transaction
    row = await t.tx((sp) =>
      sp.one(
        `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code, pack_factor, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, code, pack_factor::text AS pack_factor, source`,
        [companyId, item.id, code, round4(packFactor), source, user.id]
      )
    );
  } catch (err) {
    if (err?.code === '23505') throw await clashError();
    throw err;
  }
  return {
    result: { id: Number(row.id), code: row.code, packFactor: Number(row.pack_factor), source: row.source },
    audit: { companyId, label: item.display_name },
  };
}

export async function deleteItemBarcode(t, user, itemId, barcodeId) {
  const item = await loadItem(t, user, itemId, 'update');
  const id = positiveInt(barcodeId);
  const gone = id
    ? await t.result(`DELETE FROM tbl_inv_item_barcode WHERE id = $1 AND inv_item_id = $2`, [id, item.id])
    : { rowCount: 0 };
  if (!gone.rowCount) throw new InventoryError('NOT_FOUND', 'Barcode not found');
  return {
    result: { deleted: true },
    audit: { companyId: Number(item.hospitality_company_id), label: item.display_name },
  };
}

// ───────────────────────── hotel levels ─────────────────────────

const toLevelRow = (r) => ({
  invItemId: Number(r.id),
  displayName: r.display_name,
  stockUom: r.stock_uom,
  minQty: numOrNull(r.min_qty),
  reorderLevel: numOrNull(r.reorder_level),
  maxQty: numOrNull(r.max_qty),
  binLabel: r.bin_label ?? null,
});

const LEVEL_SELECT = `SELECT i.id, i.display_name, i.stock_uom, hi.min_qty::text AS min_qty,
       hi.reorder_level::text AS reorder_level, hi.max_qty::text AS max_qty, hi.bin_label
  FROM tbl_inv_item i
  LEFT JOIN tbl_inv_hotel_item hi ON hi.inv_item_id = i.id AND hi.hotel_id = $2`;


export async function listHotelItems(t, user, { hotelId, search, page } = {}) {
  const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'read', hotelId });
  const hotel = Number(hotelId);
  const q = String(search ?? '').trim();
  const filterParams = [companyId];
  let where = 'i.hospitality_company_id = $1 AND i.is_active';
  if (q) {
    filterParams.push(`%${escLike(q)}%`);
    where += ` AND (i.display_name ILIKE $2 OR i.item_code ILIKE $2)`;
  }
  const total = Number((await t.one(`SELECT count(*) AS n FROM tbl_inv_item i WHERE ${where}`, filterParams)).n);
  const pageNo = Math.max(1, positiveInt(page) ?? 1);
  // $2 in LEVEL_SELECT is the hotel; keep the search param after it.
  const where2 = q ? where.replace(/\$2/g, '$3') : where;
  const rows = await t.any(
    `${LEVEL_SELECT} WHERE ${where2} ORDER BY lower(i.display_name), i.id
      LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
    q ? [companyId, hotel, filterParams[1]] : [companyId, hotel]
  );
  return { rows: rows.map(toLevelRow), total };
}

const levelValue = (v, field) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad('Levels must be zero or more', field);
  return round4(n);
};

export async function saveHotelItem(t, user, { hotelId, invItemId }, body = {}) {
  const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'update', hotelId });
  const itemId = positiveInt(invItemId);
  const item = itemId
    ? await t.oneOrNone(`SELECT id, display_name FROM tbl_inv_item WHERE id = $1 AND hospitality_company_id = $2`, [
        itemId,
        companyId,
      ])
    : null;
  if (!item) throw new InventoryError('NOT_FOUND', 'Item not found');

  const minQty = levelValue(body.minQty, 'minQty');
  const reorderLevel = levelValue(body.reorderLevel, 'reorderLevel');
  const maxQty = levelValue(body.maxQty, 'maxQty');
  if (minQty != null && reorderLevel != null && minQty > reorderLevel) {
    throw bad('Minimum must not be above the reorder level', 'minQty');
  }
  if (reorderLevel != null && maxQty != null && reorderLevel > maxQty) {
    throw bad('Reorder level must not be above the maximum', 'reorderLevel');
  }
  if (minQty != null && maxQty != null && minQty > maxQty) {
    throw bad('Minimum must not be above the maximum', 'minQty');
  }
  const bin = body.binLabel == null ? '' : String(body.binLabel).trim();
  if (bin.length > 64) throw bad('The bin label is too long', 'binLabel');

  await t.none(
    `INSERT INTO tbl_inv_hotel_item
       (hotel_id, inv_item_id, hospitality_company_id, min_qty, reorder_level, max_qty, bin_label, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (hotel_id, inv_item_id) DO UPDATE
       SET min_qty = EXCLUDED.min_qty, reorder_level = EXCLUDED.reorder_level, max_qty = EXCLUDED.max_qty,
           bin_label = EXCLUDED.bin_label, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [Number(hotelId), item.id, companyId, minQty, reorderLevel, maxQty, bin || null, user.id]
  );
  const row = await t.one(`${LEVEL_SELECT} WHERE i.id = $1`, [item.id, Number(hotelId)]);
  return {
    result: toLevelRow(row),
    audit: { companyId, hotelId: Number(hotelId), label: item.display_name },
  };
}

// ───────────────────────── settings ─────────────────────────

const COMPANY_KEYS = ['overReceiptTolerancePct', 'allowNegativeStock', 'includeGstInCost', 'adjustmentAutoApproveLimit', 'countFreeze'];

async function readCompanySettings(t, companyId) {
  const s = await getEffectiveSettings(t, { companyId });
  return Object.fromEntries(COMPANY_KEYS.map((k) => [k, s[k]]));
}

export async function getCompanySettings(t, user, { companyHint = null } = {}) {
  const companyId = await resolveCompany(t, user, 'read', companyHint);
  return readCompanySettings(t, companyId);
}

export async function saveCompanySettings(t, user, body = {}, { companyHint = null } = {}) {
  const companyId = await resolveCompany(t, user, 'admin', companyHint);
  const cur = await readCompanySettings(t, companyId);
  const next = { ...cur };
  for (const k of ['allowNegativeStock', 'includeGstInCost', 'countFreeze']) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') throw bad('Invalid value', k);
      next[k] = body[k];
    }
  }
  if (body.overReceiptTolerancePct !== undefined) {
    const n = Number(body.overReceiptTolerancePct);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Tolerance must be between 0 and 100', 'overReceiptTolerancePct');
    next.overReceiptTolerancePct = n;
  }
  if (body.adjustmentAutoApproveLimit !== undefined) {
    const n = Number(body.adjustmentAutoApproveLimit);
    if (!Number.isFinite(n) || n < 0) throw bad('The limit must be zero or more', 'adjustmentAutoApproveLimit');
    next.adjustmentAutoApproveLimit = round4(n);
  }
  await t.none(
    `INSERT INTO tbl_inv_company_settings
       (hospitality_company_id, over_receipt_tolerance_pct, allow_negative_stock, include_gst_in_cost,
        adjustment_auto_approve_limit, count_freeze, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (hospitality_company_id) DO UPDATE
       SET over_receipt_tolerance_pct = EXCLUDED.over_receipt_tolerance_pct,
           allow_negative_stock = EXCLUDED.allow_negative_stock,
           include_gst_in_cost = EXCLUDED.include_gst_in_cost,
           adjustment_auto_approve_limit = EXCLUDED.adjustment_auto_approve_limit,
           count_freeze = EXCLUDED.count_freeze,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [
      companyId,
      next.overReceiptTolerancePct,
      next.allowNegativeStock,
      next.includeGstInCost,
      next.adjustmentAutoApproveLimit,
      next.countFreeze,
      user.id,
    ]
  );
  return { result: await readCompanySettings(t, companyId), audit: { companyId, label: '' } };
}

async function readHotelSettings(t, companyId, hotelId) {
  const row = await t.oneOrNone(
    `SELECT doc_code, include_gst_in_cost, stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1`,
    [hotelId]
  );
  const eff = await getEffectiveSettings(t, { companyId, hotelId });
  return {
    hotelId,
    docCode: row?.doc_code ?? null,
    includeGstInCost: row?.include_gst_in_cost ?? null,
    effectiveDocCode: eff.docCode,
    effectiveIncludeGstInCost: eff.includeGstInCost,
    stockStartedAt: eff.stockStartedAt,
  };
}

export async function getHotelSettings(t, user, hotelId) {
  const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'read', hotelId });
  return readHotelSettings(t, companyId, Number(hotelId));
}

export async function saveHotelSettings(t, user, hotelId, body = {}) {
  const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'admin', hotelId });
  const hotel = Number(hotelId);
  const cur = await t.oneOrNone(`SELECT doc_code, include_gst_in_cost FROM tbl_inv_hotel_settings WHERE hotel_id = $1`, [hotel]);
  let docCode = cur?.doc_code ?? null;
  let gst = cur?.include_gst_in_cost ?? null;

  if (body.docCode !== undefined) {
    const code = body.docCode == null ? '' : String(body.docCode).trim();
    if (!code) {
      docCode = null;
    } else {
      if (code.length > 20) throw bad('The document code can be at most 20 characters', 'docCode');
      if (!/^[A-Za-z0-9_-]+$/.test(code)) {
        throw bad('The document code can only use letters, numbers, - and _', 'docCode');
      }
      // The default code is the hotel's own id, so another hotel's numeric
      // code could collide with it.
      if (/^[0-9]+$/.test(code) && Number(code) !== hotel) {
        throw bad("A numeric document code must be this hotel's own id", 'docCode');
      }
      docCode = code;
    }
  }
  if (body.includeGstInCost !== undefined) {
    if (body.includeGstInCost !== null && typeof body.includeGstInCost !== 'boolean') {
      throw bad('Invalid value', 'includeGstInCost');
    }
    gst = body.includeGstInCost;
  }
  if (docCode) {
    const clash = await t.oneOrNone(
      `SELECT hotel_id FROM tbl_inv_hotel_settings
        WHERE hospitality_company_id = $1 AND lower(doc_code) = lower($2) AND hotel_id <> $3`,
      [companyId, docCode, hotel]
    );
    if (clash) throw new InventoryError('CONFLICT', `The document code ${docCode} is used by another hotel`, { field: 'docCode' });
  }
  await t.none(
    `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, doc_code, include_gst_in_cost, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (hotel_id) DO UPDATE
       SET doc_code = EXCLUDED.doc_code, include_gst_in_cost = EXCLUDED.include_gst_in_cost,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [hotel, companyId, docCode, gst, user.id]
  );
  return { result: await readHotelSettings(t, companyId, hotel), audit: { companyId, hotelId: hotel, label: '' } };
}

// ───────────────────────── category defaults ─────────────────────────

async function readCategoryDefaults(t, companyId) {
  const rows = await t.any(
    `SELECT cd.category_id, c.title, cd.track_expiry, cd.default_mark_out_on_arrival
       FROM tbl_inv_category_default cd LEFT JOIN tbl_category c ON c.id = cd.category_id
      WHERE cd.hospitality_company_id = $1 ORDER BY lower(c.title), cd.category_id`,
    [companyId]
  );
  return {
    rows: rows.map((r) => ({
      categoryId: Number(r.category_id),
      categoryName: r.title ?? null,
      trackExpiry: r.track_expiry === true,
      defaultMarkOutOnArrival: r.default_mark_out_on_arrival === true,
    })),
  };
}

export async function getCategoryDefaults(t, user, { companyHint = null } = {}) {
  const companyId = await resolveCompany(t, user, 'read', companyHint);
  return readCategoryDefaults(t, companyId);
}

/** Replaces the company's whole set of category defaults. */
export async function saveCategoryDefaults(t, user, body = {}, { companyHint = null } = {}) {
  const companyId = await resolveCompany(t, user, 'admin', companyHint);
  if (!Array.isArray(body.rows)) throw bad('rows must be a list', 'rows');
  const seen = new Set();
  for (const r of body.rows) {
    const id = positiveInt(r?.categoryId);
    if (!id) throw bad('Every row needs a category', 'categoryId');
    if (seen.has(id)) throw bad('A category is listed twice', 'categoryId');
    seen.add(id);
    for (const k of ['trackExpiry', 'defaultMarkOutOnArrival']) {
      if (typeof r[k] !== 'boolean') throw bad('Invalid value', k);
    }
  }
  const ids = [...seen];
  if (ids.length) {
    const found = await t.any(`SELECT id FROM tbl_category WHERE id = ANY($1::int[])`, [ids]);
    if (found.length !== ids.length) throw bad('Unknown category', 'categoryId');
  }
  await t.none(
    `DELETE FROM tbl_inv_category_default WHERE hospitality_company_id = $1 AND NOT (category_id = ANY($2::int[]))`,
    [companyId, ids]
  );
  for (const r of body.rows) {
    await t.none(
      `INSERT INTO tbl_inv_category_default
         (hospitality_company_id, category_id, track_expiry, default_mark_out_on_arrival, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (hospitality_company_id, category_id) DO UPDATE
         SET track_expiry = EXCLUDED.track_expiry,
             default_mark_out_on_arrival = EXCLUDED.default_mark_out_on_arrival,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [companyId, Number(r.categoryId), r.trackExpiry, r.defaultMarkOutOnArrival, user.id]
    );
  }
  return { result: await readCategoryDefaults(t, companyId), audit: { companyId, label: '' } };
}
