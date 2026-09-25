// ARC v2 — the one answer to "which vendors may quote on this rate contract,
// and for which hotels".
//
// RULE — the same one RFQ uses (hospitalityModel.getEligibleVendorsForVariant):
// a vendor needs a CATEGORY subscription AND a HOTEL subscription. ARC used to
// accept either one, so a category subscription alone invited a vendor to every
// hotel's rate contracts, including hotels the vendor never chose to serve.
// Product agreed to align ARC with RFQ on 2026-09-17 (Group ARC PRD §10).
//
// COVERAGE — a group ARC covers several hotels, and a regional vendor often
// serves only some of them. The resolver returns, per vendor, the covered
// hotels it may quote for. Awards are later restricted to those hotels.
//
// EXPIRED SUBSCRIPTIONS — still qualify for the invitation (the vendor can read
// and draft) but not for submission (audit H1). renewal_needed_hotel_ids names
// the hotels whose hotel or category subscription is not active, so the vendor
// sees what to renew when opening the invitation instead of at the final step.
//
// Vendor distributor networks: when a vendor can attach local distributors,
// widen hotel coverage HERE and nowhere else.

import db from '../../config/dbConn.js';

const uniqueIds = (ids) => [...new Set((ids || []).map(Number).filter(Boolean))];

/**
 * @param {{ category_id: number, hotel_ids: number[] }} args
 * @returns {Promise<Array<{ id, name, email, mobile, hotel_ids: number[], renewal_needed_hotel_ids: number[] }>>}
 */
export async function resolveArcVendorCoverage({ category_id, hotel_ids }, runner = db) {
  const hotels = uniqueIds(hotel_ids);
  if (!Number(category_id) || hotels.length === 0) return [];
  const rows = await runner.any(
    `WITH cat AS (
       SELECT vendor_id, bool_or(status = 'active') AS cat_active
         FROM tbl_vendor_hotel_category_subscription
        WHERE item_type = 'category' AND item_id = $1
          AND status IN ('active', 'expired')
        GROUP BY vendor_id
     ),
     hot AS (
       SELECT vendor_id, item_id AS hotel_id, bool_or(status = 'active') AS hotel_active
         FROM tbl_vendor_hotel_category_subscription
        WHERE item_type = 'hotel' AND item_id = ANY($2::int[])
          AND status IN ('active', 'expired')
        GROUP BY vendor_id, item_id
     )
     SELECT u.id, u.name, u.email, u.mobile,
            array_agg(hot.hotel_id ORDER BY hot.hotel_id) AS hotel_ids,
            COALESCE(
              array_agg(hot.hotel_id ORDER BY hot.hotel_id)
                FILTER (WHERE NOT (hot.hotel_active AND cat.cat_active)),
              '{}'
            ) AS renewal_needed_hotel_ids
       FROM tbl_users u
       JOIN cat ON cat.vendor_id = u.id
       JOIN hot ON hot.vendor_id = u.id
      WHERE u.user_type = 3
        AND u.status = 1
      GROUP BY u.id, u.name, u.email, u.mobile
      ORDER BY u.name`,
    [Number(category_id), hotels]
  );
  return rows.map((r) => ({
    ...r,
    hotel_ids: (r.hotel_ids || []).map(Number),
    renewal_needed_hotel_ids: (r.renewal_needed_hotel_ids || []).map(Number),
  }));
}

/**
 * May this vendor SUBMIT a binding quote? Needs an ACTIVE category
 * subscription and an ACTIVE hotel subscription for at least one of the hotels
 * it was invited for.
 */
export async function vendorCanSubmitForHotels(vendorId, { category_id, hotel_ids }, runner = db) {
  const hotels = uniqueIds(hotel_ids);
  if (!Number(vendorId) || !Number(category_id) || hotels.length === 0) return false;
  const row = await runner.oneOrNone(
    `SELECT 1
       FROM tbl_vendor_hotel_category_subscription c
       JOIN tbl_vendor_hotel_category_subscription h
         ON h.vendor_id = c.vendor_id
        AND h.item_type = 'hotel'
        AND h.item_id = ANY($3::int[])
        AND h.status = 'active'
      WHERE c.vendor_id = $1
        AND c.item_type = 'category'
        AND c.item_id = $2
        AND c.status = 'active'
      LIMIT 1`,
    [Number(vendorId), Number(category_id), hotels]
  );
  return !!row;
}

export default { resolveArcVendorCoverage, vendorCanSubmitForHotels };
