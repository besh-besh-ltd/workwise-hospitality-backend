// Stock counts (spec §8.5).
//
//   start    (inventory.create) FULL = every item with a balance or a level
//            row at the hotel; SELECTED = the given items. One item sits in
//            at most one active (open or submitted) count per hotel.
//   lines    (inventory.create, open only) each saved line records the
//            balance at that moment (system_qty_at_count) and when it was
//            counted; re-saving re-captures it. Each line of a save carries a
//            clientEventId, kept in tbl_inv_count_line_event: a key the count
//            has seen before is a replay and changes nothing, even after a
//            newer save of the same line (a late retry never overwrites a
//            newer count). An item not on the count (found while counting)
//            joins it.
//   submit   (inventory.create) computes variance qty and value (at the
//            current average) for the counted lines. A FULL count must have
//            every line counted; a SELECTED count needs at least one, and its
//            uncounted lines stay out of the posting.
//   approve  (inventory.approve) every non-zero variance needs a reason;
//            posts COUNT_IN / COUNT_OUT of counted − system_qty_at_count per
//            line (the delta, so stock that moved during the count is kept),
//            COUNT_IN at the current average. A gain on an item with no cost
//            at the hotel never posts at 0: it takes the approver's
//            unitCosts[lineId], else the latest inbound cost of the item at
//            any hotel of the company, else the approval is refused. A
//            hotel's first approved FULL count starts its stock
//            (stock_started_at).
//   cancel   (inventory.approve) open or submitted; posts nothing.
//
// Blind counts hide systemQtyAtCount and the variances from callers without
// inventory.approve at the hotel.
//
// Lock order: count row (FOR UPDATE) → per-hotel count advisory lock (when
// items join) → doc sequence (start only) → balance rows (approve: created if
// missing and locked in ledger order, so the cost decisions hold) →
// postMovements (approve only).

import { hotelIdsWithPermission } from './scope.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import { getEffectiveSettings } from './settings.js';
import {
  MAX_LINES, PAGE_SIZE, positiveInt, invalid, notFound, conflict, num, money, iso, pageOf, requireUuid, toQty,
  flag, assertDocAccess, holds, loadCompanyItems, lockBalances, hasNoCost, MAX_AMOUNT,
} from './stockCommon.js';

export const COUNT_SCOPES = Object.freeze(['FULL', 'SELECTED']);
export const COUNT_STATUSES = Object.freeze(['open', 'submitted', 'approved', 'cancelled']);
const MAX_SELECTED = 2000;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Count payload for a caller (no access check). `canApprove` decides whether
 * a blind count shows its system quantities and variances.
 */
async function loadCount(t, countId, { canCount, canApprove }) {
  const c = await t.oneOrNone(
    `SELECT c.id, c.count_number, c.hospitality_company_id, c.hotel_id, h.name AS hotel_name, c.scope, c.status,
            c.is_blind, c.started_at, c.submitted_at, c.approved_at, c.approved_by, au.name AS approved_by_name,
            c.created_by, cu.name AS created_by_name
       FROM tbl_inv_count c
       JOIN tbl_hospitality_company_hotels h ON h.id = c.hotel_id
       LEFT JOIN tbl_users au ON au.id = c.approved_by
       LEFT JOIN tbl_users cu ON cu.id = c.created_by
      WHERE c.id = $1`,
    [countId]
  );
  if (!c) throw notFound('Count not found');
  const rows = await t.any(
    `SELECT l.id, l.inv_item_id, i.display_name, i.item_code, i.stock_uom, hi.bin_label,
            l.counted_qty::text AS counted_qty, l.system_qty_at_count::text AS system_qty,
            l.variance_qty::text AS variance_qty, l.variance_value::text AS variance_value,
            b.avg_cost::text AS avg_cost, b.qty::text AS bal_qty, l.reason, l.counted_at, cb.name AS counted_by_name
       FROM tbl_inv_count_line l
       JOIN tbl_inv_item i ON i.id = l.inv_item_id
       LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = $2 AND hi.inv_item_id = l.inv_item_id
       LEFT JOIN tbl_inv_balance b     ON b.hotel_id = $2 AND b.inv_item_id = l.inv_item_id
       LEFT JOIN tbl_users cb          ON cb.id = l.counted_by
      WHERE l.count_id = $1
      ORDER BY hi.bin_label NULLS LAST, i.display_name, l.id`,
    [countId, c.hotel_id]
  );
  const hide = c.is_blind === true && !canApprove;
  // Approvers of a submitted count: which gains will need a unitCost (an
  // unlocked hint for the UI; approval decides under the locks).
  let needsCost = new Set();
  if (canApprove && c.status === 'submitted') {
    const candidates = rows.filter((r) => {
      const delta = num(r.counted_qty) - num(r.system_qty);
      const balance = r.bal_qty == null ? null : { qty: Number(r.bal_qty), avgCost: Number(r.avg_cost) };
      return r.counted_qty != null && delta > 0 && hasNoCost(balance);
    });
    if (candidates.length) {
      const costs = await latestCompanyCosts(t, Number(c.hospitality_company_id), candidates.map((r) => Number(r.inv_item_id)));
      needsCost = new Set(candidates.filter((r) => !costs.has(Number(r.inv_item_id))).map((r) => Number(r.id)));
    }
  }
  const lines = rows.map((r) => {
    const counted = num(r.counted_qty);
    const system = num(r.system_qty);
    let varianceQty = num(r.variance_qty);
    let varianceValue = num(r.variance_value);
    if (varianceQty == null && counted != null && system != null) {
      // Not submitted yet: a live figure at the current average.
      varianceQty = Math.round((counted - system) * 10000) / 10000;
      varianceValue = money(varianceQty * (num(r.avg_cost) ?? 0));
    }
    return {
      id: Number(r.id),
      invItemId: Number(r.inv_item_id),
      displayName: r.display_name,
      itemCode: r.item_code ?? null,
      stockUom: r.stock_uom,
      binLabel: r.bin_label ?? null,
      countedQty: counted,
      countedAt: iso(r.counted_at),
      countedByName: r.counted_by_name ?? null,
      systemQtyAtCount: hide ? null : system,
      varianceQty: hide ? null : varianceQty,
      varianceValue: hide ? null : money(varianceValue),
      reason: r.reason ?? null,
      needsUnitCost: needsCost.has(Number(r.id)),
    };
  });
  const counted = lines.filter((l) => l.countedQty != null);
  const { countFreeze } = await getEffectiveSettings(t, {
    companyId: Number(c.hospitality_company_id), hotelId: Number(c.hotel_id),
  });
  return {
    id: Number(c.id),
    countNumber: c.count_number ?? null,
    companyId: Number(c.hospitality_company_id),
    hotelId: Number(c.hotel_id),
    hotelName: c.hotel_name,
    scope: c.scope,
    status: c.status,
    isBlind: c.is_blind === true,
    countFreeze: countFreeze === true,
    startedAt: iso(c.started_at),
    submittedAt: iso(c.submitted_at),
    approvedAt: iso(c.approved_at),
    approvedBy: c.approved_by == null ? null : Number(c.approved_by),
    approvedByName: c.approved_by_name ?? null,
    createdBy: c.created_by == null ? null : Number(c.created_by),
    createdByName: c.created_by_name ?? null,
    lines,
    summary: {
      lineCount: lines.length,
      countedCount: counted.length,
      varianceLines: hide ? null : counted.filter((l) => l.varianceQty).length,
      varianceValue: hide ? null : money(counted.reduce((s, l) => s + (l.varianceValue ?? 0), 0)),
    },
    can: { count: canCount, approve: canApprove },
  };
}

async function payloadFor(t, user, countId, hotelId) {
  const [canCount, canApprove] = [await holds(t, user, hotelId, 'create'), await holds(t, user, hotelId, 'approve')];
  return loadCount(t, countId, { canCount, canApprove });
}

async function headerForAccess(t, countId) {
  const id = positiveInt(countId);
  const row = id ? await t.oneOrNone(`SELECT hotel_id FROM tbl_inv_count WHERE id = $1`, [id]) : null;
  if (!row) throw notFound('Count not found');
  return { id, hotelId: Number(row.hotel_id) };
}

/** GET /counts/:id: inventory.read at its hotel, else NOT_FOUND. */
export async function getCount(t, user, countId) {
  const { id, hotelId } = await headerForAccess(t, countId);
  await assertDocAccess(t, user, hotelId, 'read', { missing: 'Count not found' });
  return payloadFor(t, user, id, hotelId);
}

/** GET /counts: hotels where the user holds inventory.read, newest first; ?hotelId, ?status. */
export async function listCounts(t, user, { hotelId, status, page } = {}) {
  let hotels = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  if (hotelId != null && hotelId !== '') hotels = hotels.filter((h) => h === positiveInt(hotelId));
  if (status != null && status !== '' && !COUNT_STATUSES.includes(status)) {
    throw invalid('Unknown status', { field: 'status', allowed: COUNT_STATUSES });
  }
  if (!hotels.length) return { rows: [], total: 0 };
  const p = pageOf(page);
  const rows = await t.any(
    `SELECT c.id, c.count_number, c.hospitality_company_id, c.hotel_id, h.name AS hotel_name, c.scope, c.status,
            c.is_blind, c.started_at, c.submitted_at, c.approved_at, cu.name AS created_by_name,
            (SELECT count(*) FROM tbl_inv_count_line l WHERE l.count_id = c.id) AS line_count,
            (SELECT count(*) FROM tbl_inv_count_line l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL) AS counted_count,
            count(*) OVER () AS total
       FROM tbl_inv_count c
       JOIN tbl_hospitality_company_hotels h ON h.id = c.hotel_id
       LEFT JOIN tbl_users cu ON cu.id = c.created_by
      WHERE c.hotel_id = ANY($1::int[]) AND ($2::text IS NULL OR c.status = $2)
      ORDER BY c.started_at DESC, c.id DESC
      LIMIT $3 OFFSET $4`,
    [hotels, status || null, PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  // The hotel's effective count_freeze, once per hotel on the page.
  const freeze = new Map();
  for (const r of rows) {
    const h = Number(r.hotel_id);
    if (!freeze.has(h)) {
      const { countFreeze } = await getEffectiveSettings(t, { companyId: Number(r.hospitality_company_id), hotelId: h });
      freeze.set(h, countFreeze === true);
    }
  }
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      countNumber: r.count_number ?? null,
      hotelId: Number(r.hotel_id),
      hotelName: r.hotel_name,
      scope: r.scope,
      status: r.status,
      isBlind: r.is_blind === true,
      countFreeze: freeze.get(Number(r.hotel_id)),
      startedAt: iso(r.started_at),
      submittedAt: iso(r.submitted_at),
      approvedAt: iso(r.approved_at),
      createdByName: r.created_by_name ?? null,
      lineCount: Number(r.line_count),
      countedCount: Number(r.counted_count),
    })),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

// ---------------------------------------------------------------------------
// Start and count
// ---------------------------------------------------------------------------

/**
 * Items of `invItemIds` already in another active count at the hotel →
 * CONFLICT naming that count. Call under the hotel's count advisory lock.
 */
async function assertNoOverlap(t, { hotelId, invItemIds, exceptCountId = null }) {
  if (!invItemIds.length) return;
  const clash = await t.oneOrNone(
    `SELECT c.id, c.count_number, array_agg(l.inv_item_id ORDER BY l.inv_item_id) AS items
       FROM tbl_inv_count c
       JOIN tbl_inv_count_line l ON l.count_id = c.id
      WHERE c.hotel_id = $1 AND c.status IN ('open', 'submitted')
        AND ($3::int IS NULL OR c.id <> $3)
        AND l.inv_item_id = ANY($2::int[])
      GROUP BY c.id, c.count_number
      ORDER BY c.id
      LIMIT 1`,
    [hotelId, invItemIds, exceptCountId]
  );
  if (clash) {
    throw conflict(`Some of these items are already being counted in ${clash.count_number ?? `count #${clash.id}`}`, {
      countId: Number(clash.id),
      countNumber: clash.count_number,
      invItemIds: clash.items.slice(0, 20).map(Number),
    });
  }
}

const lockHotelCounts = (t, hotelId) =>
  t.one(`SELECT pg_advisory_xact_lock(hashtext('inv:count'), $1::int)`, [hotelId]);

/**
 * POST /counts.
 * @param {{hotelId:number, scope:'FULL'|'SELECTED', isBlind?:boolean, invItemIds?:number[]}} input
 * @returns {Promise<object>} Count
 * @throws {InventoryError} VALIDATION | NOT_FOUND | FORBIDDEN | CONFLICT (an
 *   item is in another active count: details {countId, countNumber, invItemIds})
 */
export async function startCount(t, user, input = {}) {
  const hotelId = positiveInt(input.hotelId);
  if (!hotelId) throw invalid('Choose a hotel', { field: 'hotelId' });
  // Out of the caller's sight (another company, or no read here): NOT_FOUND.
  const { companyId } = await assertDocAccess(t, user, hotelId, 'create');
  const scope = input.scope;
  if (!COUNT_SCOPES.includes(scope)) throw invalid('Choose a full or a selected count', { field: 'scope' });
  const isBlind = flag(input.isBlind);

  let itemIds;
  if (scope === 'SELECTED') {
    const raw = input.invItemIds;
    if (!Array.isArray(raw) || !raw.length) throw invalid('Pick the items to count', { field: 'invItemIds' });
    if (raw.length > MAX_SELECTED) throw invalid(`At most ${MAX_SELECTED} items per count`, { field: 'invItemIds' });
    itemIds = [...new Set(raw.map(positiveInt))];
    if (itemIds.some((id) => !id)) throw invalid('Invalid item', { field: 'invItemIds' });
    await loadCompanyItems(t, companyId, itemIds);
  } else {
    // Everything stocked or levelled here; inactive items only while they hold stock.
    itemIds = (
      await t.any(
        `SELECT i.id
           FROM tbl_inv_item i
           LEFT JOIN tbl_inv_balance b    ON b.hotel_id = $1 AND b.inv_item_id = i.id
           LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = $1 AND hi.inv_item_id = i.id
          WHERE i.hospitality_company_id = $2
            AND (b.inv_item_id IS NOT NULL OR hi.inv_item_id IS NOT NULL)
            AND (i.is_active OR COALESCE(b.qty, 0) <> 0)
          ORDER BY i.id`,
        [hotelId, companyId]
      )
    ).map((r) => Number(r.id));
  }

  await lockHotelCounts(t, hotelId);
  await assertNoOverlap(t, { hotelId, invItemIds: itemIds });

  const countNumber = await nextDocNumber(t, { hotelId, docType: 'CNT' });
  const userId = positiveInt(user.id);
  const header = await t.one(
    `INSERT INTO tbl_inv_count (count_number, hospitality_company_id, hotel_id, scope, status, is_blind, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $6) RETURNING id`,
    [countNumber, companyId, hotelId, scope, isBlind, userId]
  );
  const countId = Number(header.id);
  if (itemIds.length) {
    await t.none(
      `INSERT INTO tbl_inv_count_line (hospitality_company_id, count_id, inv_item_id)
       SELECT $1, $2, x FROM unnest($3::int[]) AS x`,
      [companyId, countId, itemIds]
    );
  }
  return payloadFor(t, user, countId, hotelId);
}

/** Load, gate and lock a count; it must be in one of `statuses`. */
async function lockCount(t, user, countId, action, statuses) {
  const { id, hotelId } = await headerForAccess(t, countId);
  const { companyId } = await assertDocAccess(t, user, hotelId, action, { missing: 'Count not found' });
  const row = await t.one(`SELECT id, status, scope FROM tbl_inv_count WHERE id = $1 FOR UPDATE`, [id]);
  if (!statuses.includes(row.status)) {
    throw conflict(`This count is ${row.status}`, { status: row.status });
  }
  return { id, hotelId, companyId, status: row.status, scope: row.scope };
}

/**
 * PUT /counts/:id/lines {lines:[{invItemId, countedQty, clientEventId}]}.
 * @returns {Promise<{count:object, replayed:boolean}>} replayed: every line
 *   was a repeat of an earlier save of this count (nothing changed). Such a
 *   save answers as a replay in any status: a retry that arrives after the
 *   count was submitted is not an error.
 * @throws {InventoryError} VALIDATION (details {field:'lines', index}: bad
 *   qty, an item or a clientEventId twice in one save, a key already used for
 *   another item) | NOT_FOUND | FORBIDDEN | CONFLICT {status} (count not open
 *   and the save has new lines; an added item is in another active count)
 */
export async function saveCountLines(t, user, countId, lines) {
  // Any status here: the applied keys are checked before the status.
  const count = await lockCount(t, user, countId, 'create', COUNT_STATUSES);
  if (!Array.isArray(lines) || !lines.length) throw invalid('Nothing to save', { field: 'lines' });
  if (lines.length > MAX_LINES) throw invalid(`At most ${MAX_LINES} lines at once`, { field: 'lines' });
  const seenItems = new Set();
  const seenEvents = new Set();
  const input = lines.map((l, index) => {
    const invItemId = positiveInt(l?.invItemId);
    if (!invItemId) throw invalid('Each line needs an item', { field: 'lines', index });
    const countedQty = toQty(l?.countedQty);
    if (countedQty == null || countedQty < 0) {
      throw invalid('Counted quantity must be 0 or more', { field: 'lines', index, invItemId });
    }
    if (seenItems.has(invItemId)) throw invalid('The same item is on two lines', { field: 'lines', index, invItemId });
    seenItems.add(invItemId);
    const clientEventId = requireUuid(l?.clientEventId);
    if (seenEvents.has(clientEventId)) {
      throw invalid('Each line needs its own clientEventId', { field: 'lines', index, invItemId });
    }
    seenEvents.add(clientEventId);
    return { index, invItemId, countedQty, clientEventId };
  });

  // Every key this count has applied before, whatever the line holds now.
  const applied = new Map(
    (
      await t.any(
        `SELECT e.client_event_id, l.inv_item_id
           FROM tbl_inv_count_line_event e
           JOIN tbl_inv_count_line l ON l.id = e.count_line_id
          WHERE e.count_id = $1 AND e.client_event_id = ANY($2::uuid[])`,
        [count.id, input.map((l) => l.clientEventId)]
      )
    ).map((r) => [r.client_event_id, Number(r.inv_item_id)])
  );
  const toSave = [];
  for (const l of input) {
    const priorItem = applied.get(l.clientEventId);
    if (priorItem == null) {
      toSave.push(l);
    } else if (priorItem !== l.invItemId) {
      throw invalid('That clientEventId was used for another item', { field: 'lines', index: l.index, invItemId: l.invItemId });
    }
    // else: a replay of a save already applied (possibly superseded since)
  }
  if (!toSave.length) return { count: await payloadFor(t, user, count.id, count.hotelId), replayed: true };
  if (count.status !== 'open') throw conflict(`This count is ${count.status}`, { status: count.status });

  const existing = new Set(
    (await t.any(`SELECT inv_item_id FROM tbl_inv_count_line WHERE count_id = $1`, [count.id])).map((e) => Number(e.inv_item_id))
  );
  const added = toSave.filter((l) => !existing.has(l.invItemId)).map((l) => l.invItemId);
  if (added.length) {
    await loadCompanyItems(t, count.companyId, added);
    await lockHotelCounts(t, count.hotelId);
    await assertNoOverlap(t, { hotelId: count.hotelId, invItemIds: added, exceptCountId: count.id });
  }

  // The system quantity at the moment of counting.
  const userId = positiveInt(user.id);
  const ids = toSave.map((l) => l.invItemId);
  const qtys = toSave.map((l) => l.countedQty);
  const events = toSave.map((l) => l.clientEventId);
  await t.none(
    `INSERT INTO tbl_inv_count_line (hospitality_company_id, count_id, inv_item_id)
     SELECT $1, $2, x FROM unnest($3::int[]) AS x
     ON CONFLICT (count_id, inv_item_id) DO NOTHING`,
    [count.companyId, count.id, ids]
  );
  await t.none(
    `UPDATE tbl_inv_count_line l
        SET counted_qty = x.counted, system_qty_at_count = COALESCE(b.qty, 0), counted_at = now(),
            counted_by = $3, client_event_id = x.event, variance_qty = NULL, variance_value = NULL,
            updated_at = now()
       FROM unnest($4::int[], $5::numeric[], $6::uuid[]) AS x(item, counted, event)
       LEFT JOIN tbl_inv_balance b ON b.hotel_id = $2 AND b.inv_item_id = x.item
      WHERE l.count_id = $1 AND l.inv_item_id = x.item`,
    [count.id, count.hotelId, userId, ids, qtys, events]
  );
  await t.none(
    `INSERT INTO tbl_inv_count_line_event
       (hospitality_company_id, count_id, count_line_id, client_event_id, counted_qty, applied_by)
     SELECT $1, $2, l.id, x.event, x.counted, $3
       FROM unnest($4::int[], $5::numeric[], $6::uuid[]) AS x(item, counted, event)
       JOIN tbl_inv_count_line l ON l.count_id = $2 AND l.inv_item_id = x.item`,
    [count.companyId, count.id, userId, ids, qtys, events]
  );
  await t.none(`UPDATE tbl_inv_count SET updated_by = $2, updated_at = now() WHERE id = $1`, [count.id, userId]);
  return { count: await payloadFor(t, user, count.id, count.hotelId), replayed: false };
}

const UNCOUNTED_LIST_MAX = 50;

/**
 * POST /counts/:id/submit: freezes the variances (qty, and value at the
 * current average) of the counted lines.
 * @throws {InventoryError} NOT_FOUND | FORBIDDEN | CONFLICT (not open) |
 *   VALIDATION {field:'lines'}: nothing counted, or (FULL) lines left
 *   uncounted: {uncounted:[{lineId, invItemId, displayName}] (first 50), uncountedTotal},
 *   or a variance too large to value: {reason:'TOO_LARGE', lines:[{lineId, invItemId, displayName}]}
 */
export async function submitCount(t, user, countId) {
  const count = await lockCount(t, user, countId, 'create', ['open']);
  const { n, uncountedTotal } = await t.one(
    `SELECT count(*) FILTER (WHERE counted_qty IS NOT NULL)::int AS n,
            count(*) FILTER (WHERE counted_qty IS NULL)::int AS "uncountedTotal"
       FROM tbl_inv_count_line WHERE count_id = $1`,
    [count.id]
  );
  if (count.scope === 'FULL' && uncountedTotal) {
    const uncounted = await t.any(
      `SELECT l.id, l.inv_item_id, i.display_name
         FROM tbl_inv_count_line l
         JOIN tbl_inv_item i ON i.id = l.inv_item_id
         LEFT JOIN tbl_inv_hotel_item hi ON hi.hotel_id = $2 AND hi.inv_item_id = l.inv_item_id
        WHERE l.count_id = $1 AND l.counted_qty IS NULL
        ORDER BY hi.bin_label NULLS LAST, i.display_name, l.id
        LIMIT $3`,
      [count.id, count.hotelId, UNCOUNTED_LIST_MAX]
    );
    throw invalid(`Count every item before submitting a full count: ${uncountedTotal} not counted yet`, {
      field: 'lines',
      uncounted: uncounted.map((r) => ({ lineId: Number(r.id), invItemId: Number(r.inv_item_id), displayName: r.display_name })),
      uncountedTotal,
    });
  }
  if (!n) throw invalid('Count at least one item before submitting', { field: 'lines' });
  // A variance valued at the average must fit numeric(18,4) (|x| < MAX_AMOUNT):
  // refuse here, naming the lines, rather than fail on the write below.
  const outsized = await t.any(
    `SELECT l.id, l.inv_item_id, i.display_name
       FROM tbl_inv_count_line l
       JOIN tbl_inv_item i ON i.id = l.inv_item_id
       LEFT JOIN tbl_inv_balance b ON b.hotel_id = $2 AND b.inv_item_id = l.inv_item_id
      WHERE l.count_id = $1 AND l.counted_qty IS NOT NULL
        AND abs(round((l.counted_qty - l.system_qty_at_count) * COALESCE(b.avg_cost, 0), 4)) >= $3
      ORDER BY i.display_name, l.id`,
    [count.id, count.hotelId, MAX_AMOUNT]
  );
  if (outsized.length) {
    throw invalid(`The difference on ${outsized.length} line(s) is too large to value: check the counted quantities`, {
      field: 'lines',
      reason: 'TOO_LARGE',
      lines: outsized.map((r) => ({ lineId: Number(r.id), invItemId: Number(r.inv_item_id), displayName: r.display_name })),
    });
  }
  await t.none(
    `UPDATE tbl_inv_count_line l
        SET variance_qty = l.counted_qty - l.system_qty_at_count,
            variance_value = round((l.counted_qty - l.system_qty_at_count) * COALESCE(
              (SELECT b.avg_cost FROM tbl_inv_balance b WHERE b.hotel_id = $2 AND b.inv_item_id = l.inv_item_id), 0), 4),
            updated_at = now()
      WHERE l.count_id = $1 AND l.counted_qty IS NOT NULL`,
    [count.id, count.hotelId]
  );
  await t.none(
    `UPDATE tbl_inv_count SET status = 'submitted', submitted_at = now(), updated_by = $2, updated_at = now() WHERE id = $1`,
    [count.id, positiveInt(user.id)]
  );
  return payloadFor(t, user, count.id, count.hotelId);
}

/** Inbound movement types whose unit cost may value a gain elsewhere in the company. */
const COST_SOURCES = ['GRN_IN', 'OPENING', 'ADJUST_IN', 'COUNT_IN'];
/** Upper bound for an approver-supplied unit cost. */
const MAX_UNIT_COST = 1e9;

/**
 * The latest inbound unit cost (> 0) of each item at any hotel of the company:
 * GRN_IN, OPENING, ADJUST_IN or COUNT_IN, leaving out receipts whose GRN line
 * was later reversed (a reversed receipt's price is not one to trust).
 * @returns {Promise<Map<number, number>>} invItemId → cost
 */
async function latestCompanyCosts(t, companyId, invItemIds) {
  if (!invItemIds.length) return new Map();
  const rows = await t.any(
    `SELECT DISTINCT ON (m.inv_item_id) m.inv_item_id, m.unit_cost::text AS unit_cost
       FROM tbl_inv_movement m
      WHERE m.hospitality_company_id = $1 AND m.inv_item_id = ANY($2::int[])
        AND m.movement_type = ANY($3::text[]) AND m.unit_cost > 0
        AND NOT (m.movement_type = 'GRN_IN' AND EXISTS (
              SELECT 1 FROM tbl_grn_line rl JOIN tbl_grn rg ON rg.id = rl.grn_id
               WHERE rl.reverses_grn_line_id = m.source_line_id AND rg.status <> 'draft'))
      ORDER BY m.inv_item_id, m.posted_at DESC, m.id DESC`,
    [companyId, [...new Set(invItemIds)], COST_SOURCES]
  );
  return new Map(rows.map((r) => [Number(r.inv_item_id), Number(r.unit_cost)]));
}

/** {[lineId]: number in (0, 1e9]} → Map(lineId → cost); VALIDATION {field:'unitCosts', lineId} otherwise. */
function parseUnitCosts(unitCosts) {
  const out = new Map();
  if (unitCosts == null) return out;
  if (typeof unitCosts !== 'object' || Array.isArray(unitCosts)) {
    throw invalid('unitCosts must map line ids to costs', { field: 'unitCosts' });
  }
  for (const [key, raw] of Object.entries(unitCosts)) {
    if (raw == null || raw === '') continue;
    const cost = toQty(raw);
    if (cost == null || cost <= 0 || cost > MAX_UNIT_COST) {
      throw invalid(`Each unit cost must be a number above 0 and at most ${MAX_UNIT_COST}`, { field: 'unitCosts', lineId: key });
    }
    out.set(Number(key), cost);
  }
  return out;
}

/** {[lineId]: text} → Map(lineId → trimmed text); VALIDATION {field:'reasons', lineId} otherwise. */
function parseReasons(reasons) {
  if (reasons != null && (typeof reasons !== 'object' || Array.isArray(reasons))) {
    throw invalid('reasons must map line ids to text', { field: 'reasons' });
  }
  const given = new Map();
  for (const [key, text] of Object.entries(reasons ?? {})) {
    if (text == null) continue;
    if (typeof text !== 'string') throw invalid('Each reason must be text', { field: 'reasons', lineId: key });
    const s = text.trim();
    if (s.length > 1000) throw invalid('A reason is too long (at most 1000 characters)', { field: 'reasons', lineId: key });
    if (s) given.set(Number(key), s);
  }
  return given;
}

/**
 * POST /counts/:id/approve {reasons:{[lineId]:string}, unitCosts?:{[lineId]:number}}:
 * posts the deltas.
 *
 * A gain on an item with no cost at the hotel (no balance, or an average of
 * 0 with nothing on hand: the ledger's own test, read under the balance
 * locks) is valued at unitCosts[lineId], else at the latest inbound unit cost
 * of the item at any hotel of the company, else the approval is refused.
 * unitCosts for other lines are ignored. Stock on hand at an average of 0
 * takes gains at 0.
 *
 * @throws {InventoryError} NOT_FOUND | FORBIDDEN | CONFLICT (not submitted) |
 *   VALIDATION, once for both lists: {field: 'reasons' when any reason is
 *   missing else 'unitCosts', lines: that field's list, reasons:[{lineId,
 *   invItemId, displayName}], unitCosts:[{lineId, invItemId, displayName}]} |
 *   VALIDATION {field:'reasons'|'unitCosts', lineId} (a malformed entry) |
 *   NEGATIVE_STOCK
 */
export async function approveCount(t, user, countId, reasons = {}, unitCosts = null) {
  const count = await lockCount(t, user, countId, 'approve', ['submitted']);
  const given = parseReasons(reasons);
  const costsGiven = parseUnitCosts(unitCosts);
  const lines = await t.any(
    `SELECT l.id, l.inv_item_id, i.display_name, l.counted_qty::text AS counted_qty,
            l.system_qty_at_count::text AS system_qty, l.reason
       FROM tbl_inv_count_line l
       JOIN tbl_inv_item i ON i.id = l.inv_item_id
      WHERE l.count_id = $1 AND l.counted_qty IS NOT NULL
      ORDER BY l.inv_item_id`,
    [count.id]
  );

  const missing = [];
  const work = lines.map((l) => {
    const delta = Math.round((Number(l.counted_qty) - Number(l.system_qty)) * 10000) / 10000;
    const reason = given.get(Number(l.id)) ?? l.reason ?? null;
    if (delta !== 0 && !reason) {
      missing.push({ lineId: Number(l.id), invItemId: Number(l.inv_item_id), displayName: l.display_name });
    }
    return { lineId: Number(l.id), invItemId: Number(l.inv_item_id), displayName: l.display_name, delta, reason };
  });

  // The cost decisions are made under the balance locks (rows created when
  // missing, in ledger order: every moving line posts), so a concurrent first
  // receipt either commits before them (its average is used) or waits.
  const moving = work.filter((w) => w.delta !== 0);
  const balances = await lockBalances(t, {
    companyId: count.companyId, hotelId: count.hotelId, invItemIds: moving.map((w) => w.invItemId), create: true,
  });
  const noCost = moving.filter((w) => w.delta > 0 && hasNoCost(balances.get(w.invItemId)));
  const costOf = new Map();
  const needFallback = [];
  for (const w of noCost) {
    if (costsGiven.has(w.lineId)) costOf.set(w.lineId, costsGiven.get(w.lineId));
    else needFallback.push(w);
  }
  const uncosted = [];
  if (needFallback.length) {
    const latest = await latestCompanyCosts(t, count.companyId, needFallback.map((w) => w.invItemId));
    for (const w of needFallback) {
      if (latest.has(w.invItemId)) costOf.set(w.lineId, latest.get(w.invItemId));
      else uncosted.push({ lineId: w.lineId, invItemId: w.invItemId, displayName: w.displayName });
    }
  }
  if (missing.length || uncosted.length) {
    const parts = [
      missing.length ? 'a reason for every line with a difference' : null,
      uncosted.length ? 'a unit cost for items with no cost anywhere in the company yet' : null,
    ].filter(Boolean);
    throw invalid(`Give ${parts.join(' and ')}`, {
      field: missing.length ? 'reasons' : 'unitCosts',
      lines: missing.length ? missing : uncosted,
      reasons: missing,
      unitCosts: uncosted,
    });
  }

  const userId = positiveInt(user.id);
  const posted = await postMovements(
    t,
    moving.map((w) => ({
      companyId: count.companyId,
      hotelId: count.hotelId,
      invItemId: w.invItemId,
      type: w.delta > 0 ? 'COUNT_IN' : 'COUNT_OUT',
      qty: w.delta,
      // undefined: the hotel's average (present for every gain not in costOf)
      unitCost: costOf.get(w.lineId),
      sourceType: 'CNT',
      sourceId: count.id,
      sourceLineId: w.lineId,
      postedBy: userId,
    }))
  );
  // A track_expiry line split across batches posts one row per batch: sum them.
  const valueOf = new Map();
  for (const m of posted) {
    valueOf.set(m.sourceLineId, Math.round(((valueOf.get(m.sourceLineId) ?? 0) + m.value) * 10000) / 10000);
  }

  if (work.length) {
    await t.none(
      `UPDATE tbl_inv_count_line l
          SET variance_qty = x.delta, variance_value = x.value, reason = x.reason, updated_at = now()
         FROM unnest($2::int[], $3::numeric[], $4::numeric[], $5::text[]) AS x(id, delta, value, reason)
        WHERE l.count_id = $1 AND l.id = x.id`,
      [
        count.id,
        work.map((w) => w.lineId),
        work.map((w) => w.delta),
        work.map((w) => valueOf.get(w.lineId) ?? 0),
        work.map((w) => w.reason),
      ]
    );
  }
  await t.none(
    `UPDATE tbl_inv_count SET status = 'approved', approved_by = $2, approved_at = now(), updated_by = $2, updated_at = now()
      WHERE id = $1`,
    [count.id, userId]
  );
  if (count.scope === 'FULL') {
    // The hotel's first approved full count starts its stock (spec §13).
    await t.none(
      `INSERT INTO tbl_inv_hotel_settings (hotel_id, hospitality_company_id, stock_started_at, created_by, updated_by)
       VALUES ($1, $2, now(), $3, $3)
       ON CONFLICT (hotel_id) DO UPDATE
         SET stock_started_at = COALESCE(tbl_inv_hotel_settings.stock_started_at, now()), updated_at = now()`,
      [count.hotelId, count.companyId, userId]
    );
  }
  return payloadFor(t, user, count.id, count.hotelId);
}

/** POST /counts/:id/cancel (inventory.approve): open or submitted; nothing posts. */
export async function cancelCount(t, user, countId) {
  const count = await lockCount(t, user, countId, 'approve', ['open', 'submitted']);
  await t.none(
    `UPDATE tbl_inv_count SET status = 'cancelled', updated_by = $2, updated_at = now() WHERE id = $1`,
    [count.id, positiveInt(user.id)]
  );
  return payloadFor(t, user, count.id, count.hotelId);
}

export default {
  startCount, saveCountLines, submitCount, approveCount, cancelCount, getCount, listCounts, COUNT_SCOPES, COUNT_STATUSES,
};
