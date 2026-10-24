// Inventory permission scope: company + hotel axes only (spec §6.1).
//
// The house authorizationService checks company, hotel, department AND process.
// Inventory has no process, and a department-scoped storekeeper still keeps the
// whole store, so here a tbl_user_role_scopes row grants its permissions on:
//   - every live hotel of its company when hotel_id IS NULL;
//   - exactly its hotel otherwise;
// whatever its department_id / process_id say.
//
// tbl_user_role_scopes.company_id is the HOSPITALITY company id.
//
// Tenancy is never read from the request: the hotel id names the record, its
// company comes from tbl_hospitality_company_hotels, and the grant from the
// user's own role scopes. Never use can().
//
// Super admins (user_type 8) pass every check. Vendors (user_type 3) and
// site-rep GRN-token users (is_token_user) never reach buyer hotels.

import { InventoryError } from './errors.js';

const SUPER_ADMIN = 8;
const VENDOR = 3;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isSuperAdmin = (user) => Number(user?.user_type) === SUPER_ADMIN;
const isOutsider = (user) => Number(user?.user_type) === VENDOR || user?.is_token_user === true;

/** Accepts one action or several (any of them grants). */
function actionList(action) {
  const list = (Array.isArray(action) ? action : [action]).filter(
    (a) => typeof a === 'string' && a.length > 0
  );
  if (!list.length) throw new InventoryError('VALIDATION', 'A permission action is required', { field: 'action' });
  return list;
}

function resourceName(resource) {
  if (typeof resource !== 'string' || !resource) {
    throw new InventoryError('VALIDATION', 'A permission resource is required', { field: 'resource' });
  }
  return resource;
}

/**
 * The hospitality company of a live (not deleted) hotel, or null.
 * @returns {Promise<number|null>}
 */
export async function companyIdForHotel(t, hotelId) {
  const id = positiveInt(hotelId);
  if (!id) return null;
  const row = await t.oneOrNone(
    `SELECT hospitality_company_id FROM tbl_hospitality_company_hotels
      WHERE id = $1 AND COALESCE(is_deleted, 0) = 0`,
    [id]
  );
  return row ? Number(row.hospitality_company_id) : null;
}

/**
 * Live hotels where the user holds resource.action (any of the actions when an
 * array is given), ascending. A user object (req.user) is also accepted: a
 * super admin then gets every live hotel, a vendor or token user none.
 *
 * @param {object} t
 * @param {number|{id:number,user_type?:number,is_token_user?:boolean}} userOrId
 * @param {string} resource  e.g. 'inventory', 'grn'
 * @param {string|string[]} action
 * @returns {Promise<number[]>}
 */
export async function hotelIdsWithPermission(t, userOrId, resource, action) {
  const res = resourceName(resource);
  const actions = actionList(action);
  const user = typeof userOrId === 'object' && userOrId !== null ? userOrId : { id: userOrId };

  if (isOutsider(user)) return [];
  if (isSuperAdmin(user)) {
    const all = await t.any(
      `SELECT id FROM tbl_hospitality_company_hotels WHERE COALESCE(is_deleted, 0) = 0 ORDER BY id`
    );
    return all.map((r) => Number(r.id));
  }
  const userId = positiveInt(user.id);
  if (!userId) return [];

  const rows = await t.any(
    `SELECT DISTINCT h.id
       FROM tbl_user_role_scopes urs
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p       ON p.id = rp.permission_id
       JOIN tbl_hospitality_company_hotels h
         ON h.hospitality_company_id = urs.company_id
        AND (urs.hotel_id IS NULL OR urs.hotel_id = h.id)
      WHERE urs.user_id = $1
        AND COALESCE(h.is_deleted, 0) = 0
        AND p.resource::text = $2
        AND p.action::text = ANY($3::text[])
      ORDER BY h.id`,
    [userId, res, actions]
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Gate an action on one hotel.
 *
 * NOT_FOUND (404) when the hotel is missing or deleted, or belongs to a company
 * the user has no footing in (no tbl_hospitality_user_mappings row and no role
 * scope there), and always for vendors / token users. FORBIDDEN (403) when the
 * user is in the hotel's company but no role scope covering this hotel grants
 * resource.action. Department and process columns are ignored.
 *
 * @param {object} t
 * @param {{id:number,user_type?:number,is_token_user?:boolean}} user  req.user
 * @param {{resource:string, action:string|string[], hotelId:number}} args
 * @returns {Promise<{companyId:number}>}
 */
export async function assertHotelPermission(t, user, { resource, action, hotelId } = {}) {
  const res = resourceName(resource);
  const actions = actionList(action);
  const notFound = () => new InventoryError('NOT_FOUND', 'Hotel not found');

  if (!user || isOutsider(user)) throw notFound();
  const hotel = positiveInt(hotelId);
  if (!hotel) throw notFound();

  const companyId = await companyIdForHotel(t, hotel);
  if (companyId == null) throw notFound();
  if (isSuperAdmin(user)) return { companyId };

  const userId = positiveInt(user.id);
  if (!userId) throw notFound();

  const row = await t.one(
    `SELECT
       (EXISTS (SELECT 1 FROM tbl_hospitality_user_mappings m
                 WHERE m.user_id = $1 AND m.hospitality_company_id = $2)
        OR EXISTS (SELECT 1 FROM tbl_user_role_scopes urs
                    WHERE urs.user_id = $1 AND urs.company_id = $2)) AS member,
       EXISTS (SELECT 1
                 FROM tbl_user_role_scopes urs
                 JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
                 JOIN tbl_permissions p       ON p.id = rp.permission_id
                WHERE urs.user_id = $1
                  AND urs.company_id = $2
                  AND (urs.hotel_id IS NULL OR urs.hotel_id = $3)
                  AND p.resource::text = $4
                  AND p.action::text = ANY($5::text[])) AS granted`,
    [userId, companyId, hotel, res, actions]
  );

  if (!row.member) throw notFound();
  if (!row.granted) {
    throw new InventoryError('FORBIDDEN', "You don't have permission to do this at this hotel", {
      resource: res,
      action: actions.length === 1 ? actions[0] : actions,
      hotelId: hotel,
    });
  }
  return { companyId };
}

export default { companyIdForHotel, hotelIdsWithPermission, assertHotelPermission };
