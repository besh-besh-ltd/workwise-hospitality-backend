// Shared helpers for the stock documents (Task C3): mark out / return,
// adjustments, counts and the stock queries. Internal to outService,
// adjustmentService, countService, stockQueries and notices/approvalNotices.
//
// Scope rules (spec §6.1, company + hotel axes only):
//   - a document's hotel comes from its own row, never from the request;
//   - a record the caller cannot read (no inventory.read, nor the action
//     asked for, at its hotel) is NOT_FOUND, exactly like a foreign one;
//   - a record the caller can read but not act on is FORBIDDEN.

import { InventoryError } from './errors.js';
import { assertHotelPermission } from './scope.js';
import { getEffectiveSettings } from './settings.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PAGE_SIZE = 50;
export const MAX_LINES = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** numeric(18,4) holds up to 14 integer digits. */
const MAX_QTY = 1e12;

/** IST calendar day, as a date (production Postgres runs in UTC). */
export const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
/** Start of the current IST calendar month, as a timestamptz. */
export const IST_MONTH_START = `(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export const positiveInt = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
export const invalid = (message, details = {}) => new InventoryError('VALIDATION', message, details);
export const notFound = (message = 'Not found', details = {}) => new InventoryError('NOT_FOUND', message, details);
export const conflict = (message, details = {}) => new InventoryError('CONFLICT', message, details);

/** numeric string | number | null → number | null */
export const num = (v) => (v == null ? null : Number(v));
/** Money for display: 2 dp. */
export const money = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
/** timestamptz → ISO string | null */
export const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** A page number ≥ 1 (anything else is page 1). */
export const pageOf = (v) => Math.max(1, positiveInt(v) ?? 1);

/** Truthy query flags: true, 'true', '1', 1. */
export const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** A required client event id (uuid), lower-cased. */
export function requireUuid(v, field = 'clientEventId') {
  if (typeof v !== 'string' || !UUID_RE.test(v.trim())) throw invalid(`${field} must be a UUID`, { field });
  return v.trim().toLowerCase();
}

/**
 * A quantity rounded to 4 dp, or null when it is not a finite number (or is
 * too large for numeric(18,4)).
 */
export function toQty(v) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim());
  else return null;
  if (!Number.isFinite(n) || Math.abs(n) >= MAX_QTY) return null;
  return Math.round(n * 10000) / 10000;
}

/** Optional trimmed text, null when blank; VALIDATION when not text or too long. */
export function optionalText(v, field, max) {
  if (v == null) return null;
  if (typeof v !== 'string') throw invalid(`Invalid ${field}`, { field });
  const s = v.trim();
  if (s.length > max) throw invalid(`${field} is too long (at most ${max} characters)`, { field });
  return s || null;
}

/** Optional 'YYYY-MM-DD' filter. */
export function optionalDay(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw invalid(`${field} must be a date (YYYY-MM-DD)`, { field });
  }
  return v;
}

/**
 * Gate an action on an existing document at `hotelId`.
 * The caller must be able to see it (inventory.read, or the action itself),
 * else NOT_FOUND; then hold the action, else FORBIDDEN.
 * @returns {Promise<{companyId:number}>}
 */
export async function assertDocAccess(t, user, hotelId, action = 'read') {
  const visible = action === 'read' ? 'read' : ['read', action];
  let scope;
  try {
    scope = await assertHotelPermission(t, user, { resource: 'inventory', action: visible, hotelId });
  } catch (err) {
    if (err instanceof InventoryError && err.code === 'FORBIDDEN') throw notFound();
    throw err;
  }
  if (action === 'read') return scope;
  return assertHotelPermission(t, user, { resource: 'inventory', action, hotelId });
}

/** Does the user hold inventory.<action> at the hotel? (never throws for a refusal) */
export async function holds(t, user, hotelId, action) {
  try {
    await assertHotelPermission(t, user, { resource: 'inventory', action, hotelId });
    return true;
  } catch (err) {
    if (err instanceof InventoryError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) return false;
    throw err;
  }
}

/**
 * Company items by id. Every id must be an item of `companyId`, else
 * NOT_FOUND (a foreign item id is treated like a missing one).
 * @returns {Promise<Map<number,{id:number, displayName:string, stockUom:string, isActive:boolean}>>}
 */
export async function loadCompanyItems(t, companyId, ids) {
  const wanted = [...new Set(ids)];
  const rows = await t.any(
    `SELECT id, display_name, stock_uom, is_active FROM tbl_inv_item
      WHERE hospitality_company_id = $1 AND id = ANY($2::int[])`,
    [companyId, wanted]
  );
  const map = new Map(
    rows.map((r) => [
      Number(r.id),
      { id: Number(r.id), displayName: r.display_name, stockUom: r.stock_uom, isActive: r.is_active === true },
    ])
  );
  const missing = wanted.find((id) => !map.has(id));
  if (missing) throw notFound('Item not found', { invItemId: missing });
  return map;
}

/**
 * The count that freezes the hotel's stock right now (spec §8.5): the
 * company's count_freeze is on AND a count is open at the hotel. Null when
 * stock may move.
 * @returns {Promise<{countId:number, countNumber:string|null}|null>}
 */
export async function freezingCount(t, { companyId, hotelId }) {
  const settings = await getEffectiveSettings(t, { companyId, hotelId });
  if (!settings.countFreeze) return null;
  const open = await t.oneOrNone(
    `SELECT id, count_number FROM tbl_inv_count WHERE hotel_id = $1 AND status = 'open' ORDER BY id LIMIT 1`,
    [hotelId]
  );
  return open ? { countId: Number(open.id), countNumber: open.count_number } : null;
}

/**
 * Count freeze (spec §8.5): when the company's count_freeze is on and a count
 * is open at the hotel, stock may not move. LOCKED names the count.
 * Every poster calls it inside its transaction, before its movements post:
 * mark out / return, adjustments (create and approve), opening import, GRN
 * post (buyer, draft, site-rep link, legacy markGRN), GRN reversal and RTV
 * dispatch. Saving a draft moves nothing and is not checked. A replay of an
 * already-posted document is answered before this check.
 */
export async function assertNotFrozen(t, { companyId, hotelId }) {
  const open = await freezingCount(t, { companyId, hotelId });
  if (open) {
    throw new InventoryError(
      'LOCKED',
      `Stock is frozen while count ${open.countNumber ?? `#${open.countId}`} is open at this hotel`,
      open
    );
  }
}

/**
 * Lock the hotel's balance rows of `invItemIds` FOR UPDATE in the ledger's
 * order (hotel, item), so a cost decision made on them holds until
 * postMovements runs in the same transaction. With `create`, missing rows are
 * inserted first (as the ledger would), so even an item's first stock is
 * serialised against a concurrent receipt; only pass it when every one of
 * those items is about to post.
 * @returns {Promise<Map<number,{qty:number, avgCost:number}>>} existing (or created) rows
 */
export async function lockBalances(t, { companyId, hotelId, invItemIds, create = false }) {
  const ids = [...new Set(invItemIds)].sort((a, b) => a - b);
  if (!ids.length) return new Map();
  if (create) {
    await t.none(
      `INSERT INTO tbl_inv_balance (hotel_id, inv_item_id, hospitality_company_id)
       SELECT $1, x, $3 FROM unnest($2::int[]) AS x ORDER BY x
       ON CONFLICT (hotel_id, inv_item_id) DO NOTHING`,
      [hotelId, ids, companyId]
    );
  }
  const rows = await t.any(
    `SELECT inv_item_id, qty::text AS qty, avg_cost::text AS avg_cost FROM tbl_inv_balance
      WHERE hotel_id = $1 AND inv_item_id = ANY($2::int[])
      ORDER BY inv_item_id FOR UPDATE`,
    [hotelId, ids]
  );
  return new Map(rows.map((r) => [Number(r.inv_item_id), { qty: Number(r.qty), avgCost: Number(r.avg_cost) }]));
}

/**
 * No cost at the hotel to value stock coming in at: no balance row, or an
 * average of 0 with nothing on hand (the ledger's own test). Stock on hand at
 * an average of 0 (a zero-priced receipt or opening line) is a real cost of 0.
 */
export const hasNoCost = (balance) => !balance || (!(balance.avgCost > 0) && balance.qty <= 0);

/**
 * Active buyer-side users holding inventory.approve at the hotel (a role scope
 * with hotel_id NULL covers every hotel of its company). Super admins are not
 * counted: they are platform staff, not the hotel's approvers.
 * @returns {Promise<number[]>}
 */
export async function approverIds(conn, hotelId) {
  const rows = await conn.any(
    `SELECT DISTINCT urs.user_id
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_user_role_scopes urs
         ON urs.company_id = h.hospitality_company_id
        AND (urs.hotel_id IS NULL OR urs.hotel_id = h.id)
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p       ON p.id = rp.permission_id
       JOIN tbl_users u             ON u.id = urs.user_id
      WHERE h.id = $1
        AND COALESCE(h.is_deleted, 0) = 0
        AND p.resource::text = 'inventory' AND p.action::text = 'approve'
        AND u.status = 1
        AND COALESCE(u.is_deleted, 0) = 0
        AND COALESCE(u.user_type, 0) NOT IN (3, 8)
      ORDER BY urs.user_id`,
    [hotelId]
  );
  return rows.map((r) => Number(r.user_id));
}

/**
 * Rewrite the ledger's "no average cost yet" refusal (details.index points at
 * a movement) so it names the item of the document line instead.
 */
export function explainMissingCost(err, lineOf) {
  if (!(err instanceof InventoryError) || err.code !== 'VALIDATION' || err.details?.field !== 'unitCost') return err;
  const line = lineOf(err.details.index);
  if (!line) return err;
  return invalid(
    `${line.displayName ?? 'This item'} has no cost at this hotel yet: post it through a receipt or an opening import first`,
    { field: 'lines', index: line.index, invItemId: line.invItemId }
  );
}
