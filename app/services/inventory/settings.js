// Effective inventory settings for a company, optionally narrowed to a hotel.
//
// tbl_inv_company_settings (PK hospitality_company_id) and
// tbl_inv_hotel_settings (PK hotel_id) are both optional: a missing row means
// "all defaults" (spec §5.1). The hotel row can override include_gst_in_cost
// (NULL = use the company value) and names the doc_code used in document
// numbers (NULL = the hotel id).

import { InventoryError } from './errors.js';

/** Spec §5.1 defaults, used for every column of a missing settings row. */
export const SETTINGS_DEFAULTS = Object.freeze({
  overReceiptTolerancePct: 0,
  allowNegativeStock: false,
  includeGstInCost: false,
  adjustmentAutoApproveLimit: 0, // 0 = every adjustment needs approval
  countFreeze: false,
});

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * @param {object} t pg-promise db or transaction
 * @param {{companyId:number, hotelId?:number|null}} scope  trusted ids (from the
 *   hotel / document row, never from the request). The hotel's own settings
 *   apply only when the hotel belongs to companyId.
 * @returns {Promise<{overReceiptTolerancePct:number, allowNegativeStock:boolean,
 *   includeGstInCost:boolean, adjustmentAutoApproveLimit:number, countFreeze:boolean,
 *   docCode:string|null, stockStartedAt:string|null}>} docCode is null only when
 *   no hotelId was given; stockStartedAt is an ISO timestamp.
 */
export async function getEffectiveSettings(t, { companyId, hotelId = null } = {}) {
  const company = positiveInt(companyId);
  if (!company) {
    throw new InventoryError('VALIDATION', 'A company is required to read inventory settings', { field: 'companyId' });
  }
  const hotel = hotelId == null ? null : positiveInt(hotelId);
  if (hotelId != null && !hotel) {
    throw new InventoryError('VALIDATION', 'Invalid hotel', { field: 'hotelId' });
  }

  const row = await t.one(
    `SELECT cs.over_receipt_tolerance_pct::text    AS over_receipt_tolerance_pct,
            cs.allow_negative_stock,
            cs.include_gst_in_cost                 AS company_gst,
            cs.adjustment_auto_approve_limit::text AS adjustment_auto_approve_limit,
            cs.count_freeze,
            hs.doc_code,
            hs.include_gst_in_cost                 AS hotel_gst,
            hs.stock_started_at
       FROM (SELECT $1::int AS company_id, $2::int AS hotel_id) k
       LEFT JOIN tbl_inv_company_settings cs ON cs.hospitality_company_id = k.company_id
       LEFT JOIN tbl_inv_hotel_settings hs
              ON hs.hotel_id = k.hotel_id AND hs.hospitality_company_id = k.company_id`,
    [company, hotel]
  );

  const companyGst = row.company_gst ?? SETTINGS_DEFAULTS.includeGstInCost;
  return {
    overReceiptTolerancePct:
      row.over_receipt_tolerance_pct == null
        ? SETTINGS_DEFAULTS.overReceiptTolerancePct
        : Number(row.over_receipt_tolerance_pct),
    allowNegativeStock: row.allow_negative_stock ?? SETTINGS_DEFAULTS.allowNegativeStock,
    includeGstInCost: row.hotel_gst ?? companyGst,
    adjustmentAutoApproveLimit:
      row.adjustment_auto_approve_limit == null
        ? SETTINGS_DEFAULTS.adjustmentAutoApproveLimit
        : Number(row.adjustment_auto_approve_limit),
    countFreeze: row.count_freeze ?? SETTINGS_DEFAULTS.countFreeze,
    docCode: hotel == null ? null : row.doc_code || String(hotel),
    stockStartedAt: row.stock_started_at ? new Date(row.stock_started_at).toISOString() : null,
  };
}

export default { getEffectiveSettings, SETTINGS_DEFAULTS };
