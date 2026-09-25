// ARC v2 — validating the shape of a GROUP rate contract draft.
//
// A group ARC covers two or more hotels of ONE company. The client names the
// lead hotel (hotel_id), every covered hotel (hotel_ids) and, per item, the
// quantity each hotel expects (hotel_qtys). Everything here is re-derived or
// re-checked server-side: the company comes from the hotels, the caller's
// access is checked at every hotel, and an item's indicative_qty is the sum of
// its split — never a client-supplied total.
//
// Errors carry httpStatus so controllers can relay them verbatim.

import rbacModel from '../../models/rbacModel.js';
import { userCanAccessArc, userHasArcScope } from './arcScope.js';

const httpError = (status, message) => Object.assign(new Error(message), { httpStatus: status });

const toIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * Validate a group ARC's coverage for the caller.
 *
 * @param {object} req — scope derives from req.user only
 * @param {{ hotel_id, hotel_ids, department_id, expectedCompanyId? }} args
 *   expectedCompanyId — on edit, the draft's company; coverage can never move it.
 * @returns {Promise<{ leadHotelId: number, hotelIds: number[], companyId: number }>}
 */
export async function resolveGroupCoverage(req, { hotel_id, hotel_ids, department_id, expectedCompanyId = null }) {
  const hotelIds = toIds(hotel_ids).sort((a, b) => a - b);
  const leadHotelId = Number(hotel_id) || null;

  const mappings = await rbacModel.getHotelCompanyMappings(hotelIds);
  if (mappings.length !== hotelIds.length) throw httpError(400, 'invalid hotel_ids');

  // Access before anything that would disclose facts about hotels the caller
  // cannot see (such as which company they belong to).
  for (const id of hotelIds) {
    if (!(await userCanAccessArc(req, id))) throw httpError(403, 'You do not have access to one of the selected hotels');
  }

  const companies = new Set(mappings.map((m) => Number(m.hospitality_company_id)));
  if (companies.size > 1) throw httpError(400, 'All hotels must belong to the same company');
  const companyId = [...companies][0];
  if (expectedCompanyId != null && Number(expectedCompanyId) !== companyId) {
    throw httpError(400, 'All hotels must belong to the same company');
  }

  if (hotelIds.length < 2) throw httpError(400, 'A group rate contract needs at least two hotels');
  if (!leadHotelId || !hotelIds.includes(leadHotelId)) {
    throw httpError(400, 'The lead hotel must be one of the covered hotels');
  }

  // The picker only offers departments the caller holds at EVERY selected
  // hotel; re-check here so a crafted request cannot bind hotels to a
  // department the caller has no standing in.
  if (Number(req?.user?.user_type) !== 8) {
    const deptId = Number(department_id) || null;
    for (const id of hotelIds) {
      const inScope = await userHasArcScope(req.user.id, {
        hospitality_company_id: companyId, hotel_id: id, department_id: deptId,
      });
      if (!inScope) throw httpError(400, 'The selected hotels do not share this department');
    }
  }

  return { leadHotelId, hotelIds, companyId };
}

/**
 * Normalise group items: every item needs a per-hotel split over covered
 * hotels only; its indicative_qty becomes the split's total.
 *
 * @returns {Array<object>} items with indicative_qty and hotel_qtys: [{ hotel_id, indicative_qty }]
 */
export function normalizeGroupItems(items, hotelIds) {
  const covered = new Set(toIds(hotelIds));
  return (items || []).map((item, index) => {
    const label = `Item ${index + 1}`;
    if (!item?.product_variant_id) throw httpError(400, `${label}: product_variant_id is required`);
    if (!Array.isArray(item.hotel_qtys) || item.hotel_qtys.length === 0) {
      throw httpError(400, `${label}: enter the quantity each hotel expects`);
    }
    const byHotel = new Map();
    for (const row of item.hotel_qtys) {
      const hotelId = Number(row?.hotel_id);
      const qty = Number(row?.qty ?? row?.indicative_qty);
      if (!covered.has(hotelId)) {
        throw httpError(400, `${label}: hotel ${row?.hotel_id} is not covered by this rate contract`);
      }
      if (!Number.isFinite(qty) || qty < 0) throw httpError(400, `${label}: quantities must be zero or more`);
      byHotel.set(hotelId, qty);
    }
    const hotel_qtys = [...byHotel.entries()]
      .sort(([a], [b]) => a - b)
      .map(([hotel_id, indicative_qty]) => ({ hotel_id, indicative_qty }));
    const total = hotel_qtys.reduce((sum, r) => sum + r.indicative_qty, 0);
    if (total <= 0) throw httpError(400, `${label}: enter a quantity for at least one hotel`);
    return { ...item, indicative_qty: total, hotel_qtys };
  });
}

export default { resolveGroupCoverage, normalizeGroupItems };
