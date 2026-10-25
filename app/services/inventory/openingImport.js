// Opening stock import (Task B3): the xlsx that starts stock-keeping at a hotel.
//
// previewOpeningStock reads the sheet and reports, per row, the matched item,
// the unit conversion and any error. Nothing is guessed: a row that does not
// match an item exactly is an error. postOpeningStock then posts the checked
// rows as ONE all-or-nothing OPENING adjustment.
//
// Matching order: Item Code, then Variant SKU (mapped item, else the item is
// created lazily), then an exact case-insensitive Item Name among the
// company's items.
//
// Preview unitCost, like the post body's, is per STOCK unit (the sheet's cost
// per Unit divided by the unit factor).
//
// Live stock is never reset. Once the hotel's stock has started
// (stock_started_at, stamped by the first import or the first approved FULL
// count), a row is refused when its item has any movement at the hotel other
// than OPENING posted at or after that moment: the import would silently undo
// those receipts and mark-outs. A count or an adjustment corrects such items.
// Items untouched since the start still import (a second department's sheet a
// few days later), and an unchanged re-upload posts zero deltas. Before the
// start nothing is refused: R1 receipts are expected, and the import posts
// deltas against them.
//
// A count freeze (spec §8.5) blocks the post; preview reports it.

import ExcelJS from 'exceljs';
import { InventoryError } from './errors.js';
import { assertVisibleHotelPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { resolveItemForVariant } from './items.js';
import { resolveUomFactor, normalizeUomLabel } from './uom.js';
import { assertNotFrozen, freezingCount, lockBalances } from './stockCommon.js';

export const MAX_ROWS = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADERS = {
  'item code': 'itemCode',
  'variant sku': 'sku',
  'item name': 'name',
  qty: 'qty',
  unit: 'unit',
  'unit cost': 'unitCost',
  bin: 'bin',
};

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const bad = (message, field, extra = {}) => new InventoryError('VALIDATION', message, { field, ...extra });
const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function cellText(cell) {
  let v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join('');
    else if ('result' in v) v = v.result && typeof v.result === 'object' ? (v.result.error ?? '') : (v.result ?? '');
    else if ('error' in v) v = v.error ?? '';
    else if ('text' in v) v = v.text ?? '';
    else v = '';
  }
  return String(v).trim();
}

async function readSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw bad('That file is not a readable .xlsx workbook', 'file');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw bad('The workbook has no sheets', 'file');

  let headerRow = null;
  const cols = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r += 1) {
    const found = {};
    ws.getRow(r).eachCell((cell, col) => {
      const key = HEADERS[cellText(cell).toLowerCase().replace(/\s+/g, ' ')];
      if (key && !(key in found)) found[key] = col;
    });
    if (found.qty && (found.itemCode || found.sku || found.name)) {
      headerRow = r;
      Object.assign(cols, found);
    }
  }
  if (!headerRow) {
    throw bad('Expected columns: Item Code or Variant SKU or Item Name, plus Qty, Unit, Unit Cost, Bin', 'file');
  }
  if (!cols.unitCost) throw bad('The Unit Cost column is missing', 'file');

  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const get = (k) => (cols[k] ? cellText(row.getCell(cols[k])) : '');
    const rec = {
      rowNo: r,
      itemCode: get('itemCode'),
      sku: get('sku'),
      name: get('name'),
      qty: get('qty'),
      unit: get('unit'),
      unitCost: get('unitCost'),
      bin: get('bin'),
    };
    if (Object.entries(rec).every(([k, v]) => k === 'rowNo' || v === '')) continue;
    rows.push(rec);
    if (rows.length > MAX_ROWS) throw bad(`At most ${MAX_ROWS} rows can be imported at once`, 'file');
  }
  if (!rows.length) throw bad('The sheet has no rows', 'file');
  return rows;
}

const parseNumber = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_MS = 330 * 60 * 1000;

/** "25 Oct 2026": the IST calendar day of a timestamp. */
function istDay(ts) {
  const d = new Date(new Date(ts).getTime() + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const activitySinceStart = (startedAt) =>
  `Has stock activity since stock started on ${istDay(startedAt)}: use a count or an adjustment`;

/**
 * Which of `invItemIds` moved at the hotel since its stock started: any
 * movement but OPENING, posted at or after stock_started_at (compared in SQL,
 * at full precision). Nothing has, while stock has not started.
 * @returns {Promise<{startedAt:Date|null, moved:Set<number>}>}
 */
async function movedSinceStart(t, { companyId, hotelId, invItemIds }) {
  const hs = await t.oneOrNone(
    `SELECT stock_started_at FROM tbl_inv_hotel_settings WHERE hotel_id = $1 AND hospitality_company_id = $2`,
    [hotelId, companyId]
  );
  const startedAt = hs?.stock_started_at ?? null;
  if (!startedAt || !invItemIds.length) return { startedAt, moved: new Set() };
  const rows = await t.any(
    `SELECT DISTINCT m.inv_item_id
       FROM tbl_inv_movement m
       JOIN tbl_inv_hotel_settings hs ON hs.hotel_id = m.hotel_id
      WHERE m.hotel_id = $1
        AND m.inv_item_id = ANY($2::int[])
        AND m.movement_type <> 'OPENING'
        AND m.posted_at >= hs.stock_started_at`,
    [hotelId, invItemIds]
  );
  return { startedAt, moved: new Set(rows.map((r) => Number(r.inv_item_id))) };
}

/**
 * @param {Buffer} buffer the uploaded xlsx
 * @returns {{rows:Array, okCount:number, errorCount:number, stockStartedAt:string|null, countFreeze:boolean}}
 *   stockStartedAt: the hotel's stock start (ISO), null before it; countFreeze:
 *   a count freeze would refuse the post right now (the company's setting is on
 *   and a count is open at the hotel).
 */
export async function previewOpeningStock(t, user, hotelId, buffer) {
  const { companyId } = await assertVisibleHotelPermission(t, user, { resource: 'inventory', action: 'admin', hotelId });
  const hotel = Number(hotelId);
  if (!buffer || !buffer.length) throw bad('Attach the opening stock .xlsx file', 'file');
  const sheet = await readSheet(buffer);

  const items = await t.any(
    `SELECT id, display_name, item_code, stock_uom, is_active FROM tbl_inv_item WHERE hospitality_company_id = $1`,
    [companyId]
  );
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const byCode = new Map();
  const byName = new Map();
  for (const i of items) {
    if (i.item_code) byCode.set(i.item_code.toLowerCase(), i);
    const k = i.display_name.trim().toLowerCase();
    byName.set(k, byName.has(k) ? null : i); // null = ambiguous
  }
  const skus = [...new Set(sheet.map((r) => r.sku.toLowerCase()).filter(Boolean))];
  const skuRows = skus.length
    ? await t.any(
        `SELECT pv.id, pv.name, lower(btrim(pv.sku)) AS sku, iv.inv_item_id
           FROM tbl_product_variant pv
           LEFT JOIN tbl_inv_item_variant iv
                  ON iv.product_variant_id = pv.id AND iv.hospitality_company_id = $1
          WHERE lower(btrim(pv.sku)) = ANY($2::text[]) AND COALESCE(pv.is_deleted, 0) = 0
          ORDER BY pv.id`,
        [companyId, skus]
      )
    : [];
  const bySku = new Map();
  for (const r of skuRows) {
    const list = bySku.get(r.sku) ?? [];
    list.push(r);
    bySku.set(r.sku, list);
  }

  const seenItems = new Set();
  const seenVariants = new Set();
  const factorCache = new Map();
  const out = [];

  for (const r of sheet) {
    const res = {
      rowNo: r.rowNo,
      invItemId: null,
      displayName: r.name || r.itemCode || r.sku,
      qty: null,
      uom: r.unit,
      factor: null,
      stockQty: null,
      unitCost: null,
      binLabel: r.bin || null,
      willCreate: false,
      productVariantId: null,
      stockUom: null,
      error: null,
    };
    out.push(res);

    const qty = parseNumber(r.qty);
    const cost = parseNumber(r.unitCost);

    // 1. match the item
    let item = null;
    let matchError = null;
    let pending = null;
    if (r.itemCode) item = byCode.get(r.itemCode.toLowerCase()) ?? null;
    if (!item && r.sku) {
      const variants = bySku.get(r.sku.toLowerCase()) ?? [];
      const mapped = [...new Set(variants.filter((v) => v.inv_item_id).map((v) => Number(v.inv_item_id)))];
      if (mapped.length === 1) item = byId.get(mapped[0]) ?? null;
      else if (mapped.length > 1 || variants.length > 1) matchError = 'Ambiguous SKU';
      else if (variants.length === 1) {
        // Unmapped variant: nothing is created here. Post creates the item,
        // with the sheet's unit as its stock unit.
        if (!normalizeUomLabel(r.unit)) matchError = 'Unknown unit';
        else pending = variants[0];
      }
    }
    if (!item && !matchError && !pending && r.name) {
      const hit = byName.get(r.name.trim().toLowerCase());
      if (hit) item = hit;
      else if (hit === null) matchError = 'Ambiguous item name';
    }
    if (!item && pending) {
      const unit = normalizeUomLabel(r.unit);
      res.displayName = pending.name || res.displayName;
      res.uom = unit;
      if (seenVariants.has(Number(pending.id))) {
        res.error = 'Duplicate item in file';
        continue;
      }
      if (qty == null || qty < 0) {
        res.error = 'Invalid quantity';
        continue;
      }
      if (cost == null || cost < 0) {
        res.error = 'Invalid unit cost';
        continue;
      }
      seenVariants.add(Number(pending.id));
      Object.assign(res, {
        willCreate: true,
        productVariantId: Number(pending.id),
        stockUom: unit,
        qty,
        factor: 1,
        stockQty: round4(qty),
        unitCost: round4(cost),
      });
      continue;
    }
    if (!item) {
      res.error = matchError ?? 'No matching item';
      continue;
    }
    res.invItemId = Number(item.id);
    res.displayName = item.display_name;
    if (item.is_active === false) {
      res.error = 'Item is inactive';
      continue;
    }
    if (seenItems.has(res.invItemId)) {
      res.error = 'Duplicate item in file';
      continue;
    }

    // 2. quantity, unit, cost
    if (qty == null || qty < 0) {
      res.error = 'Invalid quantity';
      continue;
    }
    res.qty = qty;
    const unit = normalizeUomLabel(r.unit) || item.stock_uom;
    res.uom = unit;
    const key = `${res.invItemId}|${unit.toLowerCase()}`;
    if (!factorCache.has(key)) {
      factorCache.set(key, await resolveUomFactor(t, { invItemId: res.invItemId, uomLabel: unit }));
    }
    const factor = factorCache.get(key);
    if (factor == null) {
      res.error = 'Unknown unit';
      continue;
    }
    res.factor = factor;
    res.stockQty = round4(qty * factor);
    if (cost == null || cost < 0) {
      res.error = 'Invalid unit cost';
      continue;
    }
    res.unitCost = round4(cost / factor);
    seenItems.add(res.invItemId);
  }

  // Live stock: an item that moved since the start is not the sheet's to reset.
  const { startedAt, moved } = await movedSinceStart(t, { companyId, hotelId: hotel, invItemIds: [...seenItems] });
  for (const r of out) {
    if (!r.error && r.invItemId && moved.has(r.invItemId)) r.error = activitySinceStart(startedAt);
  }

  const errorCount = out.filter((r) => r.error).length;
  const settings = await getEffectiveSettings(t, { companyId, hotelId: hotel });
  return {
    rows: out,
    okCount: out.length - errorCount,
    errorCount,
    stockStartedAt: settings.stockStartedAt,
    countFreeze: (await freezingCount(t, { companyId, hotelId: hotel })) != null,
  };
}

/**
 * Posts opening stock as one OPENING adjustment: for every row a movement of
 * (target stockQty - current balance) at the row's unit cost. All or nothing.
 * Replays of the same clientEventId return the original document.
 *
 * Refused: LOCKED {countId, countNumber} during a count freeze; VALIDATION
 * {field:'rows', rows:[{index, invItemId, error}]} for bad rows, including an
 * item that moved since the hotel's stock started (checked under the balance
 * locks).
 *
 * @returns {Promise<{result:{adjustmentId:number, adjustmentNumber:string}, audit:object}>}
 */
export async function postOpeningStock(t, user, hotelId, rows, clientEventId) {
  const { companyId } = await assertVisibleHotelPermission(t, user, { resource: 'inventory', action: 'admin', hotelId });
  const hotel = Number(hotelId);
  if (typeof clientEventId !== 'string' || !UUID_RE.test(clientEventId)) {
    throw bad('clientEventId must be a UUID', 'clientEventId');
  }
  if (!Array.isArray(rows) || !rows.length) throw bad('There are no rows to post', 'rows');
  if (rows.length > MAX_ROWS) throw bad(`At most ${MAX_ROWS} rows can be posted at once`, 'rows');

  // Serialise replays of one client event, then answer from the first.
  await t.one(`SELECT pg_advisory_xact_lock(hashtext('inv:opening'), hashtext($1))`, [clientEventId]);
  const prior = await t.oneOrNone(
    `SELECT id, adjustment_number, hotel_id, hospitality_company_id FROM tbl_inv_adjustment WHERE client_event_id = $1`,
    [clientEventId]
  );
  if (prior) {
    if (Number(prior.hotel_id) !== hotel || Number(prior.hospitality_company_id) !== companyId) {
      throw new InventoryError('CONFLICT', 'That clientEventId was used for another document');
    }
    return {
      result: { adjustmentId: Number(prior.id), adjustmentNumber: prior.adjustment_number },
      audit: { companyId, hotelId: hotel, label: prior.adjustment_number },
    };
  }
  // A replay (above) still answers during a count freeze; a new import waits.
  await assertNotFrozen(t, { companyId, hotelId: hotel });

  // Validate every row before touching anything. A row with invItemId null
  // names a catalogue variant plus the stock unit its item will be created with.
  const problems = [];
  const clean = [];
  const seen = new Set();
  const seenVariants = new Set();
  rows.forEach((r, index) => {
    const invItemId = r?.invItemId == null ? null : positiveInt(r.invItemId);
    const variantId = positiveInt(r?.productVariantId);
    const stockUom = normalizeUomLabel(r?.stockUom);
    const stockQty = Number(r?.stockQty);
    const unitCost = Number(r?.unitCost);
    const bin = r?.binLabel == null ? '' : String(r.binLabel).trim();
    let error = null;
    if (r?.invItemId == null) {
      if (!variantId) error = 'Invalid item';
      else if (!stockUom || stockUom.length > 99) error = 'Unknown unit';
      else if (seenVariants.has(variantId)) error = 'Duplicate item';
      seenVariants.add(variantId);
    } else if (!invItemId) error = 'Invalid item';
    else if (seen.has(invItemId)) error = 'Duplicate item';
    if (invItemId) seen.add(invItemId);
    if (!error) {
      if (r?.stockQty === '' || r?.stockQty == null || !Number.isFinite(stockQty) || stockQty < 0) error = 'Invalid quantity';
      else if (r?.unitCost === '' || r?.unitCost == null || !Number.isFinite(unitCost) || unitCost < 0) error = 'Invalid unit cost';
      else if (bin.length > 64) error = 'Bin label is too long';
    }
    if (error) problems.push({ index, invItemId, error });
    else {
      clean.push({
        index,
        invItemId,
        variantId: invItemId ? null : variantId,
        stockUom,
        stockQty: round4(stockQty),
        unitCost: round4(unitCost),
        bin: bin || null,
      });
    }
  });
  if (!problems.length) {
    const ids = clean.filter((r) => r.invItemId).map((r) => r.invItemId);
    const ok = await t.any(
      `SELECT id FROM tbl_inv_item WHERE hospitality_company_id = $1 AND is_active AND id = ANY($2::int[])`,
      [companyId, ids]
    );
    const okSet = new Set(ok.map((r) => Number(r.id)));
    for (const r of clean) {
      if (r.invItemId && !okSet.has(r.invItemId)) problems.push({ index: r.index, invItemId: r.invItemId, error: 'No matching item' });
    }
  }
  if (!problems.length) {
    // Create the missing items here, in the posting transaction: a failure
    // anywhere below rolls them back with everything else.
    for (const r of clean.filter((x) => !x.invItemId)) {
      const made = await resolveItemForVariant(t, {
        companyId,
        productVariantId: r.variantId,
        createIfMissing: true,
        userId: user.id,
        defaultUom: r.stockUom,
      });
      if (!made.created) {
        // Mapped since the preview: its stock unit may differ from the sheet's.
        problems.push({ index: r.index, invItemId: made.id, error: 'Already has an item: preview again' });
      } else {
        r.invItemId = made.id;
      }
    }
  }
  if (problems.length) {
    throw new InventoryError('VALIDATION', `${problems.length} row(s) have errors: fix them and try again`, {
      field: 'rows',
      rows: problems,
    });
  }

  // Lock order: item rows (created above) → doc sequence → balances → settings.
  const adjustmentNumber = await nextDocNumber(t, { hotelId: hotel, docType: 'ADJ' });
  clean.sort((a, b) => a.invItemId - b.invItemId);

  // The balance rows, locked in ledger order, with the missing ones inserted
  // first (lockBalances create): postMovements then never inserts while it
  // holds other rows' locks, and an item's first receipt committing meanwhile
  // is waited for rather than missed. Only items that will post get a row: a
  // target above 0 posts against a missing row; a target of 0 posts only
  // against an existing one (one appearing after this read is left alone).
  const zeroTargets = clean.filter((r) => r.stockQty === 0).map((r) => r.invItemId);
  const zeroWithRow = new Set(
    zeroTargets.length
      ? (await t.any(`SELECT inv_item_id FROM tbl_inv_balance WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])`, [
        hotel, zeroTargets,
      ])).map((b) => Number(b.inv_item_id))
      : []
  );
  const current = await lockBalances(t, {
    companyId,
    hotelId: hotel,
    invItemIds: clean.filter((r) => r.stockQty > 0 || zeroWithRow.has(r.invItemId)).map((r) => r.invItemId),
    create: true,
  });

  // Under those locks, so a mark-out or receipt cannot slip in between the
  // check and the post: an item that moved since stock started is refused.
  const { startedAt, moved } = await movedSinceStart(t, {
    companyId, hotelId: hotel, invItemIds: clean.map((r) => r.invItemId),
  });
  const live = clean.filter((r) => moved.has(r.invItemId)).sort((a, b) => a.index - b.index);
  if (live.length) {
    throw new InventoryError('VALIDATION', `${live.length} row(s) have errors: fix them and try again`, {
      field: 'rows',
      rows: live.map((r) => ({ index: r.index, invItemId: r.invItemId, error: activitySinceStart(startedAt) })),
    });
  }
  for (const r of clean) r.delta = round4(r.stockQty - (current.get(r.invItemId)?.qty ?? 0));

  const adj = await t.one(
    `INSERT INTO tbl_inv_adjustment
       (adjustment_number, hospitality_company_id, hotel_id, reason_code, status, remarks,
        approved_by, approved_at, client_event_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'OPENING', 'posted', 'Opening stock', $4, now(), $5, $4, $4)
     RETURNING id`,
    [adjustmentNumber, companyId, hotel, user.id, clientEventId]
  );
  const lines = await t.any(
    `INSERT INTO tbl_inv_adjustment_line (hospitality_company_id, adjustment_id, inv_item_id, qty, unit_cost, remarks)
     SELECT $1, $2, x.item, x.qty, x.cost, x.bin
       FROM unnest($3::int[], $4::numeric[], $5::numeric[], $6::text[]) AS x(item, qty, cost, bin)
     RETURNING id, inv_item_id`,
    [
      companyId,
      adj.id,
      clean.map((r) => r.invItemId),
      clean.map((r) => r.delta),
      clean.map((r) => r.unitCost),
      clean.map((r) => r.bin),
    ]
  );
  const lineOf = new Map(lines.map((l) => [Number(l.inv_item_id), Number(l.id)]));

  const movements = clean
    .filter((r) => r.delta !== 0)
    .map((r) => ({
      companyId,
      hotelId: hotel,
      invItemId: r.invItemId,
      type: 'OPENING',
      qty: r.delta,
      unitCost: r.unitCost,
      sourceType: 'ADJ',
      sourceId: Number(adj.id),
      sourceLineId: lineOf.get(r.invItemId),
      reasonCode: 'OPENING',
      postedBy: user.id,
    }));
  if (movements.length) await postMovements(t, movements);

  const withBin = clean.filter((r) => r.bin);
  if (withBin.length) {
    await t.none(
      `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, bin_label, created_by, updated_by)
       SELECT $1, x.item, $2, x.bin, $3, $3 FROM unnest($4::int[], $5::text[]) AS x(item, bin)
       ON CONFLICT (hotel_id, inv_item_id) DO UPDATE
         SET bin_label = EXCLUDED.bin_label, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [hotel, companyId, user.id, withBin.map((r) => r.invItemId), withBin.map((r) => r.bin)]
    );
  }
  await t.none(
    `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, stock_started_at, created_by, updated_by)
     VALUES ($1, $2, now(), $3, $3)
     ON CONFLICT (hotel_id) DO UPDATE
       SET stock_started_at = COALESCE(tbl_inv_hotel_settings.stock_started_at, now()), updated_at = now()`,
    [hotel, companyId, user.id]
  );

  return {
    result: { adjustmentId: Number(adj.id), adjustmentNumber },
    audit: { companyId, hotelId: hotel, label: adjustmentNumber },
  };
}
