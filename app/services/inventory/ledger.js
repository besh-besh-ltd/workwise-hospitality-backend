// The stock ledger posting service: the ONLY writer of tbl_inv_movement and
// tbl_inv_balance (spec §5.2). Every document action (post GRN, mark out,
// approve count, RTV, opening import) calls postMovements ONCE, inside the
// same db.tx that writes the document, so stock and paperwork commit together.
//
// Algorithm, per call:
//   1. Validate every movement; drop qty = 0 (the DB's sign CHECK refuses them).
//   2. Check each hotel and item belongs to the movement's company.
//   3. Insert any missing balance rows (ON CONFLICT DO NOTHING), then lock all
//      of them with one SELECT … FOR UPDATE ordered by (hotel_id, inv_item_id).
//      Every caller takes locks in that same order, so two posts touching the
//      same items serialise instead of deadlocking, and the second one sees
//      the first one's committed quantities.
//   4. Apply the movements in input order (a receipt followed by a mark-out
//      on arrival of the same item is fine), running the negative-stock guard
//      on every outbound movement. All short movements are reported in one
//      NEGATIVE_STOCK error, and nothing is written. GRN_REVERSAL and RTV_OUT
//      are guarded even when the company allows negative stock (spec: a
//      reversal that would drive stock negative is blocked); the check runs
//      here, under the lock, because a caller's pre-check would race.
//   5. Insert the movement rows (with qty_after / avg_cost_after) and write the
//      final balance per (hotel, item).
//
// Caller rules: call postMovements once per transaction (the lock order is
// only global within one call); take nextDocNumber BEFORE postMovements (so
// every poster takes the sequence lock, then the balance locks); and rely on
// the quantity invariant only (balance.qty = Σ movement.qty), not on value.
//
// Valuation: moving weighted average per (hotel, item), numeric(18,4).
//   - Inbound (GRN_IN, RETURN_IN, ADJUST_IN, COUNT_IN, OPENING > 0) at its
//     unitCost: value += qty·cost; avg = value / qty. When nothing (or a
//     deficit) was on hand, avg = cost. RETURN_IN, COUNT_IN and ADJUST_IN may
//     omit unitCost: they are then valued at the avg read under the lock
//     (VALIDATION when there is none yet: avg 0 with nothing on hand).
//   - Outbound (MARK_OUT, ADJUST_OUT, COUNT_OUT, OPENING < 0) at the current
//     avg, which does not change. The movement that empties the balance takes
//     exactly the value left, so no rounding residue stays on a zero balance.
//   - GRN_REVERSAL / RTV_OUT at the given unitCost (the original receipt cost),
//     else at avg. At a given cost the rest is re-averaged:
//     avg = (value − qty·cost) / qty_new while qty_new > 0 (the value is
//     floored at 0, so avg never goes negative); avg is unchanged otherwise.
//   Only the quantity reconciles exactly. Value is written off (balance.value
//   ≠ Σ movement.value) when a reversal at receipt cost takes more than the
//   remaining value (floor at 0) or empties the balance, and when a receipt
//   lands on a negative balance (avg resets to cost).
//
// Arithmetic is exact fixed-point (BigInt, 4 decimals, half away from zero:
// what Postgres does when it stores numeric(18,4)); no float rounding drift.
//
// Idempotency (client_event_id) lives on the document tables, not here: the
// caller looks its document up by clientEventId before posting.

import { InventoryError } from './errors.js';
import { getEffectiveSettings } from './settings.js';

export const INBOUND_TYPES = Object.freeze(['GRN_IN', 'RETURN_IN', 'ADJUST_IN', 'COUNT_IN']);
export const OUTBOUND_TYPES = Object.freeze(['GRN_REVERSAL', 'RTV_OUT', 'MARK_OUT', 'ADJUST_OUT', 'COUNT_OUT']);
/** OPENING is a delta against the current balance and may be either sign. */
export const MOVEMENT_TYPES = Object.freeze([...INBOUND_TYPES, ...OUTBOUND_TYPES, 'OPENING']);
/** Outbound types valued at the movement's unitCost when one is given. */
const AT_GIVEN_COST = new Set(['GRN_REVERSAL', 'RTV_OUT']);
/** Outbound types that may never drive stock negative, whatever the settings. */
const ALWAYS_GUARDED = new Set(['GRN_REVERSAL', 'RTV_OUT']);
/** Inbound types valued at the current average when unitCost is omitted. */
const COST_DEFAULTS_TO_AVG = new Set(['RETURN_IN', 'COUNT_IN', 'ADJUST_IN']);

// ---------------------------------------------------------------------------
// numeric(18,4) as BigInt "ten-thousandths"
// ---------------------------------------------------------------------------

const ONE = 10000n;
const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/** Integer division rounded half away from zero (Postgres numeric rounding). */
function roundDiv(n, d) {
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return negative ? -q : q;
}

/** A number or decimal string → ten-thousandths, rounded to 4 dp; null if not a finite decimal. */
function toScaled(raw) {
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    s = String(raw);
    if (/e/i.test(s)) return Math.abs(raw) < 1 ? 0n : null; // < 1e-6 rounds to 0; ≥ 1e21 overflows
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return null;
  }
  const m = DECIMAL_RE.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = m[3] || '';
  let magnitude = BigInt(m[2] || '0') * ONE + BigInt(`${frac}0000`.slice(0, 4));
  if (frac.length > 4 && frac[4] >= '5') magnitude += 1n;
  return m[1] === '-' ? -magnitude : magnitude;
}

/** Ten-thousandths → '123.4500' (a pg numeric literal). */
function toDecimalString(n) {
  const negative = n < 0n;
  const a = negative ? -n : n;
  return `${negative ? '-' : ''}${a / ONE}.${(a % ONE).toString().padStart(4, '0')}`;
}

const toNumber = (n) => Number(toDecimalString(n));
const mul = (a, b) => roundDiv(a * b, ONE);
const div = (a, b) => roundDiv(a * ONE, b);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const positiveInt = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One caller movement → the normalised line, or null when qty is 0 (dropped). */
function normalise(m, index) {
  const fail = (field, message) => new InventoryError('VALIDATION', message, { index, field });
  if (!m || typeof m !== 'object') throw fail(null, 'Invalid stock movement');

  const companyId = positiveInt(m.companyId);
  if (!companyId) throw fail('companyId', 'A stock movement needs a company');
  const hotelId = positiveInt(m.hotelId);
  if (!hotelId) throw fail('hotelId', 'A stock movement needs a hotel');
  const invItemId = positiveInt(m.invItemId);
  if (!invItemId) throw fail('invItemId', 'A stock movement needs an item');

  const { type } = m;
  if (!MOVEMENT_TYPES.includes(type)) throw fail('type', `Unknown stock movement type ${type}`);

  const qty = toScaled(m.qty);
  if (qty === null) throw fail('qty', 'Quantity must be a number');
  if (qty === 0n) return null;
  if (INBOUND_TYPES.includes(type) && qty < 0n) throw fail('qty', `${type} needs a positive quantity`);
  if (OUTBOUND_TYPES.includes(type) && qty > 0n) throw fail('qty', `${type} needs a negative quantity`);

  let unitCost = null;
  if (m.unitCost != null && m.unitCost !== '') {
    unitCost = toScaled(m.unitCost);
    if (unitCost === null || unitCost < 0n) throw fail('unitCost', 'Unit cost must be a number of 0 or more');
  }
  if (qty > 0n && unitCost === null && !COST_DEFAULTS_TO_AVG.has(type)) {
    throw fail('unitCost', `${type} needs a unit cost`);
  }

  const optionalId = (field) => {
    if (m[field] == null) return null;
    const id = positiveInt(m[field]);
    if (!id) throw fail(field, `Invalid ${field}`);
    return id;
  };
  const optionalText = (field, max) => {
    if (m[field] == null || m[field] === '') return null;
    if (typeof m[field] !== 'string' || m[field].length > max) throw fail(field, `Invalid ${field}`);
    return m[field];
  };

  if (typeof m.sourceType !== 'string' || !m.sourceType.trim() || m.sourceType.length > 20) {
    throw fail('sourceType', 'A stock movement needs a source type');
  }
  const sourceId = positiveInt(m.sourceId);
  if (!sourceId) throw fail('sourceId', 'A stock movement needs a source document');

  // Strings only: pg hands DATE columns back as JS Dates at local midnight,
  // which would shift a day on the way back in. Select them as ::text.
  let expiryDate = null;
  if (m.expiryDate != null && m.expiryDate !== '') {
    if (typeof m.expiryDate !== 'string' || !DATE_RE.test(m.expiryDate)) {
      throw fail('expiryDate', "expiryDate must be a 'YYYY-MM-DD' string");
    }
    expiryDate = m.expiryDate;
  }

  return {
    index,
    companyId,
    hotelId,
    invItemId,
    type,
    qty,
    unitCost,
    productVariantId: optionalId('productVariantId'),
    departmentId: optionalId('departmentId'),
    batchNo: optionalText('batchNo', 64),
    expiryDate,
    sourceType: m.sourceType,
    sourceId,
    sourceLineId: optionalId('sourceLineId'),
    reasonCode: optionalText('reasonCode', 30),
    postedBy: optionalId('postedBy'), // NULL for site-rep token receipts
  };
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/**
 * One movement against a balance {qty, avg, value} (all ten-thousandths).
 * @returns {{unitCost:bigint, value:bigint, next:{qty:bigint, avg:bigint, value:bigint}}}
 */
function apply(balance, line) {
  const { qty, unitCost } = line;
  const qtyNew = balance.qty + qty;

  if (qty > 0n) {
    const value = mul(qty, unitCost);
    if (balance.qty <= 0n) {
      // Nothing (or a deficit) on hand: this receipt sets the average.
      return { unitCost, value, next: { qty: qtyNew, avg: unitCost, value: mul(qtyNew, unitCost) } };
    }
    const valueNew = balance.value + value;
    return { unitCost, value, next: { qty: qtyNew, avg: div(valueNew, qtyNew), value: valueNew } };
  }

  if (AT_GIVEN_COST.has(line.type) && unitCost !== null) {
    const value = mul(qty, unitCost);
    if (qtyNew > 0n) {
      const left = balance.value + value;
      const valueNew = left < 0n ? 0n : left;
      return { unitCost, value, next: { qty: qtyNew, avg: div(valueNew, qtyNew), value: valueNew } };
    }
    return { unitCost, value, next: { qty: qtyNew, avg: balance.avg, value: mul(qtyNew, balance.avg) } };
  }

  // At the current average, which stays put. Emptying the balance takes
  // exactly what is left, so a zero balance carries zero value.
  const value = qtyNew === 0n && balance.qty > 0n ? -balance.value : mul(qty, balance.avg);
  return { unitCost: balance.avg, value, next: { qty: qtyNew, avg: balance.avg, value: balance.value + value } };
}

// ---------------------------------------------------------------------------
// postMovements
// ---------------------------------------------------------------------------

const keyOf = (hotelId, invItemId) => `${hotelId}:${invItemId}`;

function rowToMovement(r) {
  const optionalNumber = (v) => (v == null ? null : Number(v));
  return {
    id: Number(r.id),
    companyId: r.hospitality_company_id,
    hotelId: r.hotel_id,
    invItemId: r.inv_item_id,
    productVariantId: r.product_variant_id,
    type: r.movement_type,
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    value: Number(r.value),
    qtyAfter: Number(r.qty_after),
    avgCostAfter: Number(r.avg_cost_after),
    departmentId: r.department_id,
    batchNo: r.batch_no,
    expiryDate: r.expiry_date,
    sourceType: r.source_type,
    sourceId: Number(r.source_id),
    sourceLineId: optionalNumber(r.source_line_id),
    reasonCode: r.reason_code,
    postedBy: r.posted_by,
    postedAt: new Date(r.posted_at).toISOString(),
  };
}

async function negativeStockError(t, shortfalls) {
  const names = new Map(
    (
      await t.any(`SELECT id, display_name FROM tbl_inv_item WHERE id = ANY($1::int[])`, [
        [...new Set(shortfalls.map((s) => s.invItemId))],
      ])
    ).map((r) => [r.id, r.display_name])
  );
  const lines = shortfalls.map((s) => ({ ...s, itemName: names.get(s.invItemId) ?? null }));
  const [first] = lines;
  const message =
    lines.length === 1
      ? `Not enough stock of ${first.itemName ?? 'this item'}: ${first.available} available, ${first.requested} requested`
      : `Not enough stock for ${lines.length} lines`;
  return new InventoryError('NEGATIVE_STOCK', message, {
    hotelId: first.hotelId,
    invItemId: first.invItemId,
    itemName: first.itemName,
    available: first.available,
    requested: first.requested,
    lines,
  });
}

/**
 * Post stock movements and update balances. Must run inside the caller's
 * transaction; call it once per transaction with every movement of the action.
 *
 * @param {object} t pg-promise transaction
 * @param {Array<{companyId:number, hotelId:number, invItemId:number,
 *   productVariantId?:number, type:string, qty:number|string, unitCost?:number|string,
 *   departmentId?:number, batchNo?:string, expiryDate?:string, sourceType:string,
 *   sourceId:number, sourceLineId?:number, reasonCode?:string, postedBy:number|null}>} movements
 *   qty is signed, in stock units. unitCost is per stock unit: required for
 *   GRN_IN and OPENING > 0; optional for RETURN_IN / COUNT_IN / ADJUST_IN
 *   (default: the current avg); used on GRN_REVERSAL / RTV_OUT when given;
 *   ignored on the other outbound types.
 * @returns {Promise<object[]>} the written rows in input order (zero-qty
 *   movements are not written), numbers as JS numbers. See rowToMovement.
 * @throws {InventoryError} VALIDATION (details {index, field}, plus hotelId /
 *   invItemId when a defaulted unit cost has no average to fall back on) or
 *   NEGATIVE_STOCK (details {hotelId, invItemId, itemName, available,
 *   requested, lines:[{index, hotelId, invItemId, sourceLineId, itemName,
 *   available, requested}]}: the first short movement at the top level, every
 *   short movement in lines). GRN_REVERSAL / RTV_OUT are guarded even when the
 *   company allows negative stock. Nothing is written when it throws.
 */
export async function postMovements(t, movements) {
  if (!t?.ctx?.inTransaction) {
    throw new Error('postMovements must run inside a transaction');
  }
  if (!Array.isArray(movements)) {
    throw new InventoryError('VALIDATION', 'Stock movements must be a list', { field: 'movements' });
  }
  const lines = [];
  movements.forEach((m, index) => {
    const line = normalise(m, index);
    if (line) lines.push(line);
  });
  if (!lines.length) return [];

  // Distinct (hotel, item) keys in lock order.
  const keys = new Map();
  for (const l of lines) {
    const k = keyOf(l.hotelId, l.invItemId);
    const seen = keys.get(k);
    if (!seen) keys.set(k, { hotelId: l.hotelId, invItemId: l.invItemId, companyId: l.companyId, index: l.index });
    else if (seen.companyId !== l.companyId) {
      throw new InventoryError('VALIDATION', 'Stock movements disagree on the company', { index: l.index, field: 'companyId' });
    }
  }
  const sorted = [...keys.values()].sort((a, b) => a.hotelId - b.hotelId || a.invItemId - b.invItemId);
  const hotelIds = sorted.map((k) => k.hotelId);
  const itemIds = sorted.map((k) => k.invItemId);
  const companyIds = sorted.map((k) => k.companyId);

  // The hotel and the item must both belong to the movement's company.
  const owners = await t.any(
    `SELECT k.ord, h.hospitality_company_id AS hotel_company, i.hospitality_company_id AS item_company
       FROM unnest($1::int[], $2::int[]) WITH ORDINALITY AS k(hotel_id, inv_item_id, ord)
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = k.hotel_id
       LEFT JOIN tbl_inv_item i ON i.id = k.inv_item_id`,
    [hotelIds, itemIds]
  );
  for (const o of owners) {
    const k = sorted[Number(o.ord) - 1];
    if (o.hotel_company !== k.companyId) {
      throw new InventoryError('VALIDATION', 'Hotel not found for this company', { index: k.index, field: 'hotelId' });
    }
    if (o.item_company !== k.companyId) {
      throw new InventoryError('VALIDATION', 'Item not found for this company', { index: k.index, field: 'invItemId' });
    }
  }

  const allowNegative = new Map();
  const settingMatters = lines.filter((l) => l.qty < 0n && !ALWAYS_GUARDED.has(l.type));
  for (const companyId of new Set(settingMatters.map((l) => l.companyId))) {
    allowNegative.set(companyId, (await getEffectiveSettings(t, { companyId })).allowNegativeStock);
  }

  await t.none(
    `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id)
     SELECT k.hotel_id, k.inv_item_id, k.company_id
       FROM unnest($1::int[], $2::int[], $3::int[]) AS k(hotel_id, inv_item_id, company_id)
      ORDER BY k.hotel_id, k.inv_item_id
     ON CONFLICT (hotel_id, inv_item_id) DO NOTHING`,
    [hotelIds, itemIds, companyIds]
  );
  // Rows are locked in ORDER BY order (Postgres sorts, then locks).
  const locked = await t.any(
    `SELECT b.hotel_id, b.inv_item_id,
            b.qty::text AS qty, b.avg_cost::text AS avg_cost, b.value::text AS value
       FROM tbl_inv_balance b
       JOIN unnest($1::int[], $2::int[]) AS k(hotel_id, inv_item_id)
         ON b.hotel_id = k.hotel_id AND b.inv_item_id = k.inv_item_id
      ORDER BY b.hotel_id, b.inv_item_id
        FOR UPDATE OF b`,
    [hotelIds, itemIds]
  );
  if (locked.length !== sorted.length) {
    throw new Error(`postMovements: locked ${locked.length} of ${sorted.length} balance rows`);
  }

  const state = new Map(
    locked.map((b) => [
      keyOf(b.hotel_id, b.inv_item_id),
      { qty: toScaled(b.qty), avg: toScaled(b.avg_cost), value: toScaled(b.value) },
    ])
  );

  const shortfalls = [];
  const posted = [];
  for (const line of lines) {
    const k = keyOf(line.hotelId, line.invItemId);
    const balance = state.get(k);
    const guarded = ALWAYS_GUARDED.has(line.type) || !allowNegative.get(line.companyId);
    if (line.qty < 0n && balance.qty + line.qty < 0n && guarded) {
      // Not applied: later movements see the stock this one could not take.
      shortfalls.push({
        index: line.index,
        hotelId: line.hotelId,
        invItemId: line.invItemId,
        sourceLineId: line.sourceLineId,
        available: toNumber(balance.qty),
        requested: toNumber(-line.qty),
      });
      continue;
    }
    let costed = line;
    if (line.qty > 0n && line.unitCost === null) {
      // RETURN_IN / COUNT_IN / ADJUST_IN without a cost: the average under the lock.
      if (balance.avg === 0n && balance.qty <= 0n) {
        throw new InventoryError(
          'VALIDATION',
          'This item has no average cost at this hotel yet: enter a unit cost',
          { index: line.index, field: 'unitCost', hotelId: line.hotelId, invItemId: line.invItemId }
        );
      }
      costed = { ...line, unitCost: balance.avg };
    }
    const { unitCost, value, next } = apply(balance, costed);
    state.set(k, next);
    posted.push({ ...line, unitCost, value, qtyAfter: next.qty, avgCostAfter: next.avg });
  }
  if (shortfalls.length) throw await negativeStockError(t, shortfalls);

  const col = (fn) => posted.map(fn);
  const rows = await t.any(
    `INSERT INTO tbl_inv_movement
       (hospitality_company_id, hotel_id, inv_item_id, product_variant_id, movement_type,
        qty, unit_cost, value, qty_after, avg_cost_after,
        department_id, batch_no, expiry_date, source_type, source_id, source_line_id,
        reason_code, posted_by)
     SELECT m.company_id, m.hotel_id, m.inv_item_id, m.product_variant_id, m.movement_type,
            m.qty, m.unit_cost, m.value, m.qty_after, m.avg_cost_after,
            m.department_id, m.batch_no, m.expiry_date, m.source_type, m.source_id, m.source_line_id,
            m.reason_code, m.posted_by
       FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::text[],
                   $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[],
                   $11::int[], $12::text[], $13::date[], $14::text[], $15::bigint[], $16::bigint[],
                   $17::text[], $18::int[])
            WITH ORDINALITY AS m(company_id, hotel_id, inv_item_id, product_variant_id, movement_type,
                                 qty, unit_cost, value, qty_after, avg_cost_after,
                                 department_id, batch_no, expiry_date, source_type, source_id, source_line_id,
                                 reason_code, posted_by, ord)
      ORDER BY m.ord
     RETURNING id::text AS id, hospitality_company_id, hotel_id, inv_item_id, product_variant_id,
               movement_type, qty::text AS qty, unit_cost::text AS unit_cost, value::text AS value,
               qty_after::text AS qty_after, avg_cost_after::text AS avg_cost_after,
               department_id, batch_no, expiry_date::text AS expiry_date, source_type,
               source_id::text AS source_id, source_line_id::text AS source_line_id,
               reason_code, posted_by, posted_at`,
    [
      col((p) => p.companyId),
      col((p) => p.hotelId),
      col((p) => p.invItemId),
      col((p) => p.productVariantId),
      col((p) => p.type),
      col((p) => toDecimalString(p.qty)),
      col((p) => toDecimalString(p.unitCost)),
      col((p) => toDecimalString(p.value)),
      col((p) => toDecimalString(p.qtyAfter)),
      col((p) => toDecimalString(p.avgCostAfter)),
      col((p) => p.departmentId),
      col((p) => p.batchNo),
      col((p) => p.expiryDate),
      col((p) => p.sourceType),
      col((p) => p.sourceId),
      col((p) => p.sourceLineId),
      col((p) => p.reasonCode),
      col((p) => p.postedBy),
    ]
  );

  const finals = sorted.map((k) => state.get(keyOf(k.hotelId, k.invItemId)));
  await t.none(
    `UPDATE tbl_inv_balance b
        SET qty = u.qty, avg_cost = u.avg_cost, value = u.value,
            last_movement_at = now(), updated_at = now()
       FROM unnest($1::int[], $2::int[], $3::numeric[], $4::numeric[], $5::numeric[])
            AS u(hotel_id, inv_item_id, qty, avg_cost, value)
      WHERE b.hotel_id = u.hotel_id AND b.inv_item_id = u.inv_item_id`,
    [
      hotelIds,
      itemIds,
      finals.map((s) => toDecimalString(s.qty)),
      finals.map((s) => toDecimalString(s.avg)),
      finals.map((s) => toDecimalString(s.value)),
    ]
  );

  // Ids follow insertion order, which follows input order.
  return rows
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map(rowToMovement);
}

export default { postMovements, MOVEMENT_TYPES, INBOUND_TYPES, OUTBOUND_TYPES };
