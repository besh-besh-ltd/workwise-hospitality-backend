// Stock adjustments (spec §8.4): wastage, breakage, expiry, theft/loss,
// correction and found stock. (OPENING adjustments are written by the
// opening-stock import only; they show up in the reads here.)
//
// inventory.create records an adjustment. With `submit` set and an estimated
// value Σ|qty × avg_cost| at or below the company's
// adjustment_auto_approve_limit (> 0), it posts at once; otherwise it waits
// as pending_approval and the hotel's approvers are told. A limit of 0 (the
// default) means every adjustment needs approval.
//
// inventory.approve holders approve (posting ADJUST_IN / ADJUST_OUT, inbound
// at the current average) or reject with a reason. Nobody approves their own
// adjustment while another approver exists for the hotel; a sole approver may.
//
// Lines are signed stock quantities. The sign follows the reason: wastage,
// breakage, expiry and theft/loss take stock out; found brings it in;
// correction goes either way.
//
// Lock order: client-event advisory lock → doc sequence (nextDocNumber) →
// postMovements (balances). Approval: adjustment row → postMovements.

import { InventoryError } from './errors.js';
import { assertHotelPermission, hotelIdsWithPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';
import { nextDocNumber } from './docNumber.js';
import { postMovements } from './ledger.js';
import {
  MAX_LINES, PAGE_SIZE, positiveInt, invalid, notFound, conflict, num, money, iso, pageOf, requireUuid, toQty,
  optionalText, assertDocAccess, holds, loadCompanyItems, assertNotFrozen, approverIds, explainMissingCost,
} from './stockCommon.js';

export const ADJUSTMENT_REASONS = Object.freeze(['WASTAGE', 'BREAKAGE', 'EXPIRY', 'THEFT_LOSS', 'CORRECTION', 'FOUND']);
export const ADJUSTMENT_STATUSES = Object.freeze(['draft', 'pending_approval', 'posted', 'rejected']);
const OUT_ONLY = new Set(['WASTAGE', 'BREAKAGE', 'EXPIRY', 'THEFT_LOSS']);
const IN_ONLY = new Set(['FOUND']);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const HEADER_SELECT = `
  SELECT a.id, a.adjustment_number, a.hospitality_company_id, a.hotel_id, h.name AS hotel_name,
         a.reason_code, a.status, a.remarks, a.created_at, a.created_by, cu.name AS created_by_name,
         a.approved_at, a.approved_by, au.name AS approved_by_name,
         a.rejected_at, a.rejected_by, ru.name AS rejected_by_name, a.rejection_reason, a.client_event_id
    FROM tbl_inv_adjustment a
    JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
    LEFT JOIN tbl_users cu ON cu.id = a.created_by
    LEFT JOIN tbl_users au ON au.id = a.approved_by
    LEFT JOIN tbl_users ru ON ru.id = a.rejected_by`;

/**
 * May `user` approve this pending adjustment? Holds inventory.approve at the
 * hotel, and is not its creator unless nobody else can approve there.
 */
async function approvalVerdict(t, user, adj) {
  if (adj.status !== 'pending_approval') return { approve: false, reject: false, reason: 'STATUS' };
  if (!(await holds(t, user, adj.hotelId, 'approve'))) return { approve: false, reject: false, reason: 'PERMISSION' };
  if (adj.createdBy != null && adj.createdBy === positiveInt(user.id)) {
    const others = (await approverIds(t, adj.hotelId)).filter((id) => id !== adj.createdBy);
    if (others.length) return { approve: false, reject: true, reason: 'SELF_APPROVAL', otherApprovers: others.length };
  }
  return { approve: true, reject: true };
}

/**
 * Adjustment payload (no access check). Lines carry the posted movement's
 * unit cost and signed value once posted; before that, an estimate at the
 * current average.
 */
export async function loadAdjustment(t, adjustmentId) {
  const a = await t.oneOrNone(`${HEADER_SELECT} WHERE a.id = $1`, [adjustmentId]);
  if (!a) throw notFound('Adjustment not found');
  const lines = await t.any(
    `SELECT l.id, l.inv_item_id, i.display_name, i.item_code, i.stock_uom, l.qty::text AS qty, l.remarks,
            l.unit_cost::text AS line_cost,
            m.unit_cost::text AS posted_cost, m.value::text AS posted_value,
            b.avg_cost::text AS avg_cost
       FROM tbl_inv_adjustment_line l
       JOIN tbl_inv_item i ON i.id = l.inv_item_id
       LEFT JOIN tbl_inv_movement m
         ON m.source_type = 'ADJ' AND m.source_id = l.adjustment_id AND m.source_line_id = l.id
        AND m.hospitality_company_id = l.hospitality_company_id
       LEFT JOIN tbl_inv_balance b ON b.hotel_id = $2 AND b.inv_item_id = l.inv_item_id
      WHERE l.adjustment_id = $1
      ORDER BY l.id`,
    [adjustmentId, a.hotel_id]
  );
  const posted = a.status === 'posted';
  const mapped = lines.map((l) => {
    const qty = Number(l.qty);
    let unitCost;
    let value;
    if (posted) {
      unitCost = num(l.posted_cost ?? l.line_cost);
      value = l.posted_value != null ? Number(l.posted_value) : 0; // a zero OPENING delta posts nothing
    } else {
      unitCost = num(l.avg_cost) ?? 0;
      value = money(qty * unitCost);
    }
    return {
      id: Number(l.id),
      invItemId: Number(l.inv_item_id),
      displayName: l.display_name,
      itemCode: l.item_code ?? null,
      stockUom: l.stock_uom,
      qty,
      unitCost,
      value,
      remarks: l.remarks ?? null,
    };
  });
  return {
    id: Number(a.id),
    adjustmentNumber: a.adjustment_number ?? null,
    companyId: Number(a.hospitality_company_id),
    hotelId: Number(a.hotel_id),
    hotelName: a.hotel_name,
    reasonCode: a.reason_code,
    status: a.status,
    remarks: a.remarks ?? null,
    value: money(mapped.reduce((s, l) => s + Math.abs(l.value ?? 0), 0)),
    lines: mapped,
    clientEventId: a.client_event_id ?? null,
    createdAt: iso(a.created_at),
    createdBy: a.created_by == null ? null : Number(a.created_by),
    createdByName: a.created_by_name ?? null,
    approvedAt: iso(a.approved_at),
    approvedBy: a.approved_by == null ? null : Number(a.approved_by),
    approvedByName: a.approved_by_name ?? null,
    rejectedAt: iso(a.rejected_at),
    rejectedBy: a.rejected_by == null ? null : Number(a.rejected_by),
    rejectedByName: a.rejected_by_name ?? null,
    rejectionReason: a.rejection_reason ?? null,
  };
}

/** The payload plus what this user may do with it. */
async function payloadFor(t, user, adjustmentId) {
  const adj = await loadAdjustment(t, adjustmentId);
  const verdict = await approvalVerdict(t, user, adj);
  return { ...adj, can: { approve: verdict.approve, reject: verdict.reject } };
}

async function loadHeaderForAccess(t, adjustmentId) {
  const id = positiveInt(adjustmentId);
  const row = id ? await t.oneOrNone(`SELECT id, hotel_id FROM tbl_inv_adjustment WHERE id = $1`, [id]) : null;
  if (!row) throw notFound('Adjustment not found');
  return { id, hotelId: Number(row.hotel_id) };
}

/** GET /adjustments/:id: inventory.read at its hotel, else NOT_FOUND. */
export async function getAdjustment(t, user, adjustmentId) {
  const { id, hotelId } = await loadHeaderForAccess(t, adjustmentId);
  await assertDocAccess(t, user, hotelId, 'read');
  return payloadFor(t, user, id);
}

/**
 * GET /adjustments: hotels where the user holds inventory.read, newest first,
 * PAGE_SIZE a page; ?hotelId and ?status narrow it.
 */
export async function listAdjustments(t, user, { hotelId, status, page } = {}) {
  let hotels = await hotelIdsWithPermission(t, user, 'inventory', 'read');
  if (hotelId != null && hotelId !== '') hotels = hotels.filter((h) => h === positiveInt(hotelId));
  if (status != null && status !== '' && !ADJUSTMENT_STATUSES.includes(status)) {
    throw invalid('Unknown status', { field: 'status', allowed: ADJUSTMENT_STATUSES });
  }
  if (!hotels.length) return { rows: [], total: 0 };
  const p = pageOf(page);
  const rows = await t.any(
    `SELECT s.*, count(*) OVER () AS total FROM (${HEADER_SELECT}
      WHERE a.hotel_id = ANY($1::int[]) AND ($2::text IS NULL OR a.status = $2)) s
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $3 OFFSET $4`,
    [hotels, status || null, PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  if (!rows.length) return { rows: [], total: 0 };

  const ids = rows.map((r) => Number(r.id));
  const sums = new Map(
    (
      await t.any(
        `SELECT l.adjustment_id, count(*) AS line_count,
                sum(abs(CASE WHEN a.status = 'posted' THEN COALESCE(m.value, 0)
                             ELSE l.qty * COALESCE(b.avg_cost, 0) END))::text AS value
           FROM tbl_inv_adjustment_line l
           JOIN tbl_inv_adjustment a ON a.id = l.adjustment_id
           LEFT JOIN tbl_inv_movement m
             ON m.source_type = 'ADJ' AND m.source_id = l.adjustment_id AND m.source_line_id = l.id
            AND m.hospitality_company_id = l.hospitality_company_id
           LEFT JOIN tbl_inv_balance b ON b.hotel_id = a.hotel_id AND b.inv_item_id = l.inv_item_id
          WHERE l.adjustment_id = ANY($1::int[])
          GROUP BY l.adjustment_id`,
        [ids]
      )
    ).map((r) => [Number(r.adjustment_id), r])
  );

  // What the caller may act on: approve holders, minus their own adjustments
  // where another approver exists.
  const approveHotels = new Set(await hotelIdsWithPermission(t, user, 'inventory', 'approve'));
  const me = positiveInt(user?.id);
  const others = new Map();
  for (const h of new Set(rows.filter((r) => Number(r.created_by) === me).map((r) => Number(r.hotel_id)))) {
    others.set(h, (await approverIds(t, h)).some((id) => id !== me));
  }

  return {
    rows: rows.map((r) => {
      const hotel = Number(r.hotel_id);
      const pending = r.status === 'pending_approval';
      const mayAct = pending && approveHotels.has(hotel);
      const own = Number(r.created_by) === me;
      const sum = sums.get(Number(r.id));
      return {
        id: Number(r.id),
        adjustmentNumber: r.adjustment_number ?? null,
        hotelId: hotel,
        hotelName: r.hotel_name,
        reasonCode: r.reason_code,
        status: r.status,
        remarks: r.remarks ?? null,
        lineCount: sum ? Number(sum.line_count) : 0,
        value: sum ? money(sum.value) : 0,
        createdAt: iso(r.created_at),
        createdByName: r.created_by_name ?? null,
        approvedAt: iso(r.approved_at),
        approvedByName: r.approved_by_name ?? null,
        rejectedAt: iso(r.rejected_at),
        rejectedByName: r.rejected_by_name ?? null,
        can: { approve: mayAct && !(own && others.get(hotel)), reject: mayAct },
      };
    }),
    total: Number(rows[0].total),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * The adjustment an earlier request with this client event id created, or
 * null. A key used at another company is NOT_FOUND; at another hotel, CONFLICT.
 */
export async function replayAdjustment(t, user, clientEventId, { hotelId = null, companyId = null } = {}) {
  const key = requireUuid(clientEventId);
  const prior = await t.oneOrNone(
    `SELECT id, hotel_id, hospitality_company_id FROM tbl_inv_adjustment WHERE client_event_id = $1`,
    [key]
  );
  if (!prior) return null;
  if (companyId != null && Number(prior.hospitality_company_id) !== companyId) throw notFound('Adjustment not found');
  if (hotelId != null && Number(prior.hotel_id) !== hotelId) {
    throw conflict('That clientEventId was used for another document', { field: 'clientEventId' });
  }
  await assertDocAccess(t, user, Number(prior.hotel_id), 'create');
  const adjustment = await payloadFor(t, user, Number(prior.id));
  return { adjustment, replayed: true, needsApproval: false };
}

function validateLines(lines, reasonCode) {
  if (!Array.isArray(lines) || !lines.length) throw invalid('Add at least one item', { field: 'lines' });
  if (lines.length > MAX_LINES) throw invalid(`At most ${MAX_LINES} items per adjustment`, { field: 'lines' });
  const seen = new Set();
  return lines.map((l, index) => {
    const invItemId = positiveInt(l?.invItemId);
    if (!invItemId) throw invalid('Each line needs an item', { field: 'lines', index });
    const qty = toQty(l?.qty);
    if (qty == null || qty === 0) throw invalid('Each line needs a quantity other than 0', { field: 'lines', index, invItemId });
    if (OUT_ONLY.has(reasonCode) && qty > 0) {
      throw invalid('This reason takes stock out: use a negative quantity', { field: 'lines', index, invItemId });
    }
    if (IN_ONLY.has(reasonCode) && qty < 0) {
      throw invalid('Found stock comes in: use a positive quantity', { field: 'lines', index, invItemId });
    }
    if (seen.has(invItemId)) {
      throw invalid('The same item is on two lines: combine them', { field: 'lines', index, invItemId });
    }
    seen.add(invItemId);
    return { index, invItemId, qty, remarks: optionalText(l?.remarks, 'remarks', 1000) };
  });
}

/** ADJUST_IN / ADJUST_OUT for an adjustment's lines (no unit cost: the ledger values at avg). */
function movementsFor({ companyId, hotelId, adjustmentId, reasonCode, userId }, lines) {
  return lines.map((l) => ({
    companyId,
    hotelId,
    invItemId: l.invItemId,
    type: l.qty > 0 ? 'ADJUST_IN' : 'ADJUST_OUT',
    qty: l.qty,
    sourceType: 'ADJ',
    sourceId: adjustmentId,
    sourceLineId: l.lineId,
    reasonCode,
    postedBy: userId,
  }));
}

async function post(t, ctx, lines, items) {
  try {
    await postMovements(t, movementsFor(ctx, lines));
  } catch (err) {
    throw explainMissingCost(err, (index) => {
      const l = lines[index];
      return l && { ...l, displayName: items.get(l.invItemId)?.displayName };
    });
  }
}

/**
 * POST /adjustments.
 *
 * @param {{hotelId:number, reasonCode:string, remarks?:string, submit:boolean,
 *   clientEventId:string, lines:Array<{invItemId:number, qty:number, remarks?:string}>}} input
 * @returns {Promise<{adjustment:object, replayed:boolean, needsApproval:boolean}>}
 *   adjustment.status is 'posted' when it was auto-approved, else
 *   'pending_approval' (needsApproval true: notify the approvers after commit).
 * @throws {InventoryError} VALIDATION | NOT_FOUND | FORBIDDEN | CONFLICT |
 *   LOCKED (count freeze) | NEGATIVE_STOCK (auto-post only)
 */
export async function createAdjustment(t, user, input = {}) {
  const clientEventId = requireUuid(input.clientEventId);
  const hotelId = positiveInt(input.hotelId);
  if (!hotelId) throw invalid('Choose a hotel', { field: 'hotelId' });
  const { companyId } = await assertHotelPermission(t, user, { resource: 'inventory', action: 'create', hotelId });

  await t.one(`SELECT pg_advisory_xact_lock(hashtext('inv:adjustment'), hashtext($1))`, [clientEventId]);
  const prior = await replayAdjustment(t, user, clientEventId, { hotelId, companyId });
  if (prior) return prior;

  const reasonCode = input.reasonCode;
  if (!ADJUSTMENT_REASONS.includes(reasonCode)) {
    throw invalid('Choose a reason', { field: 'reasonCode', allowed: ADJUSTMENT_REASONS });
  }
  const remarks = optionalText(input.remarks, 'remarks', 2000);
  const lines = validateLines(input.lines, reasonCode);
  const items = await loadCompanyItems(t, companyId, lines.map((l) => l.invItemId));

  await assertNotFrozen(t, { companyId, hotelId });

  // Estimate at the current average (read without locks: it only picks the
  // route, the ledger values the posting under its own lock).
  const balances = new Map(
    (
      await t.any(
        `SELECT inv_item_id, qty::text AS qty, avg_cost::text AS avg_cost FROM tbl_inv_balance
          WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])`,
        [hotelId, lines.map((l) => l.invItemId)]
      )
    ).map((b) => [Number(b.inv_item_id), { qty: Number(b.qty), avg: Number(b.avg_cost) }])
  );
  for (const l of lines) {
    const b = balances.get(l.invItemId);
    if (l.qty > 0 && (!b || (b.avg === 0 && b.qty <= 0))) {
      throw invalid(
        `${items.get(l.invItemId).displayName} has no cost at this hotel yet: post it through a receipt or an opening import first`,
        { field: 'lines', index: l.index, invItemId: l.invItemId }
      );
    }
  }
  const value = lines.reduce((s, l) => s + Math.abs(l.qty * (balances.get(l.invItemId)?.avg ?? 0)), 0);
  const { adjustmentAutoApproveLimit: limit } = await getEffectiveSettings(t, { companyId, hotelId });
  const autoPost = input.submit === true && limit > 0 && Math.round(value * 10000) / 10000 <= limit;

  const adjustmentNumber = await nextDocNumber(t, { hotelId, docType: 'ADJ' });
  const userId = positiveInt(user.id);
  const header = await t.one(
    `INSERT INTO tbl_inv_adjustment
       (adjustment_number, hospitality_company_id, hotel_id, reason_code, status, remarks,
        approved_by, approved_at, client_event_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END, $9, $10, $10)
     RETURNING id`,
    [adjustmentNumber, companyId, hotelId, reasonCode, autoPost ? 'posted' : 'pending_approval', remarks,
      autoPost ? userId : null, autoPost, clientEventId, userId]
  );
  const adjustmentId = Number(header.id);
  const written = await t.any(
    `INSERT INTO tbl_inv_adjustment_line (hospitality_company_id, adjustment_id, inv_item_id, qty, remarks)
     SELECT $1, $2, x.item, x.qty, x.remarks
       FROM unnest($3::int[], $4::numeric[], $5::text[]) WITH ORDINALITY AS x(item, qty, remarks, ord)
      ORDER BY x.ord
     RETURNING id, inv_item_id`,
    [companyId, adjustmentId, lines.map((l) => l.invItemId), lines.map((l) => l.qty), lines.map((l) => l.remarks)]
  );
  const lineIdOf = new Map(written.map((w) => [Number(w.inv_item_id), Number(w.id)]));

  if (autoPost) {
    await post(
      t,
      { companyId, hotelId, adjustmentId, reasonCode, userId },
      lines.map((l) => ({ ...l, lineId: lineIdOf.get(l.invItemId) })),
      items
    );
  }

  return { adjustment: await payloadFor(t, user, adjustmentId), replayed: false, needsApproval: !autoPost };
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/** Load, gate (visible → NOT_FOUND, approve → FORBIDDEN) and lock a pending adjustment. */
async function lockForDecision(t, user, adjustmentId) {
  const { id, hotelId } = await loadHeaderForAccess(t, adjustmentId);
  const { companyId } = await assertDocAccess(t, user, hotelId, 'approve');
  const row = await t.one(
    `SELECT id, hotel_id, hospitality_company_id, reason_code, status, created_by
       FROM tbl_inv_adjustment WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (row.status !== 'pending_approval') {
    throw conflict(`This adjustment is already ${row.status.replace('_', ' ')}`, { status: row.status });
  }
  return {
    id,
    hotelId,
    companyId,
    reasonCode: row.reason_code,
    status: row.status,
    createdBy: row.created_by == null ? null : Number(row.created_by),
  };
}

/**
 * POST /adjustments/:id/approve: posts the adjustment.
 * @throws {InventoryError} NOT_FOUND | FORBIDDEN (no inventory.approve, or
 *   details.reason 'SELF_APPROVAL') | CONFLICT (not pending) | LOCKED |
 *   NEGATIVE_STOCK | VALIDATION
 */
export async function approveAdjustment(t, user, adjustmentId) {
  const adj = await lockForDecision(t, user, adjustmentId);
  const verdict = await approvalVerdict(t, user, adj);
  if (!verdict.approve) {
    throw new InventoryError(
      'FORBIDDEN',
      'Another approver must approve an adjustment you raised',
      { reason: 'SELF_APPROVAL', otherApprovers: verdict.otherApprovers ?? 0 }
    );
  }
  await assertNotFrozen(t, { companyId: adj.companyId, hotelId: adj.hotelId });

  const lines = (
    await t.any(
      `SELECT id, inv_item_id, qty::text AS qty FROM tbl_inv_adjustment_line WHERE adjustment_id = $1 ORDER BY id`,
      [adj.id]
    )
  ).map((l, index) => ({ index, lineId: Number(l.id), invItemId: Number(l.inv_item_id), qty: Number(l.qty) }));
  const items = await loadCompanyItems(t, adj.companyId, lines.map((l) => l.invItemId));
  const userId = positiveInt(user.id);
  await post(t, { companyId: adj.companyId, hotelId: adj.hotelId, adjustmentId: adj.id, reasonCode: adj.reasonCode, userId }, lines, items);

  await t.none(
    `UPDATE tbl_inv_adjustment
        SET status = 'posted', approved_by = $2, approved_at = now(), updated_by = $2, updated_at = now()
      WHERE id = $1`,
    [adj.id, userId]
  );
  return payloadFor(t, user, adj.id);
}

/**
 * POST /adjustments/:id/reject {reason}: nothing posts.
 * @throws {InventoryError} NOT_FOUND | FORBIDDEN | CONFLICT | VALIDATION (reason)
 */
export async function rejectAdjustment(t, user, adjustmentId, reason) {
  const adj = await lockForDecision(t, user, adjustmentId);
  const text = optionalText(reason, 'reason', 1000);
  if (!text) throw invalid('Give a reason for rejecting', { field: 'reason' });
  const userId = positiveInt(user.id);
  await t.none(
    `UPDATE tbl_inv_adjustment
        SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3,
            updated_by = $2, updated_at = now()
      WHERE id = $1`,
    [adj.id, userId, text]
  );
  return payloadFor(t, user, adj.id);
}

export default {
  createAdjustment, approveAdjustment, rejectAdjustment, getAdjustment, listAdjustments, loadAdjustment,
  replayAdjustment, ADJUSTMENT_REASONS, ADJUSTMENT_STATUSES,
};
