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
//
// VENDOR NETWORKS (spec §5.2): the invitation goes to the org principal. An eligible
// entity linked into an org (ACTIVE or SUSPENDED, the collapseToPrincipals rule) is
// reported as its principal, and the principal's row unions the hotels of every
// entity collapsed into it. A hotel needs renewal only when no contributing entity
// is fully active for it. Submission (vendorCanSubmitForHotels) counts the
// subscriptions of every holder (subscriptionHolderIdsFor).

import db from '../../config/dbConn.js';
import { subscriptionHolderIdsFor } from '../../services/vendorNetwork/actingContext.js';

const uniqueIds = (ids) => [...new Set((ids || []).map(Number).filter(Boolean))];

/**
 * @param {{ category_id: number, hotel_ids: number[] }} args
 * @returns {Promise<Array<{ id, name, email, mobile, hotel_ids: number[], renewal_needed_hotel_ids: number[] }>>}
 */
export async function resolveArcVendorCoverage({ category_id, hotel_ids }, runner = db) {
  const hotels = uniqueIds(hotel_ids);
  if (!Number(category_id) || hotels.length === 0) return [];
  // The collapse is done in this statement (not with collapseToPrincipals) because the
  // union needs each entity's principal, not only the set of principals.
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
     ),
     eligible AS (
       SELECT u.id AS vendor_id, hot.hotel_id, (hot.hotel_active AND cat.cat_active) AS fully_active
         FROM tbl_users u
         JOIN cat ON cat.vendor_id = u.id
         JOIN hot ON hot.vendor_id = u.id
        WHERE u.user_type = 3
          AND u.status = 1
     ),
     by_principal AS (
       SELECT COALESCE(o.principal_vendor_id, el.vendor_id) AS vendor_id,
              el.hotel_id,
              bool_or(el.fully_active) AS fully_active
         FROM eligible el
         LEFT JOIN tbl_vendor_org_entities e
           ON e.vendor_id = el.vendor_id AND e.status IN ('ACTIVE', 'SUSPENDED')
         LEFT JOIN tbl_vendor_orgs o ON o.id = e.org_id
        GROUP BY 1, 2
     )
     SELECT u.id, u.name, u.email, u.mobile,
            array_agg(bp.hotel_id ORDER BY bp.hotel_id) AS hotel_ids,
            COALESCE(
              array_agg(bp.hotel_id ORDER BY bp.hotel_id) FILTER (WHERE NOT bp.fully_active),
              '{}'
            ) AS renewal_needed_hotel_ids
       FROM by_principal bp
       JOIN tbl_users u ON u.id = bp.vendor_id
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
  // Any holder's category subscription and any holder's hotel subscription; in no org
  // the only holder is the vendor itself.
  const holderIds = await subscriptionHolderIdsFor(Number(vendorId), runner);
  const row = await runner.oneOrNone(
    `SELECT 1
       FROM tbl_vendor_hotel_category_subscription c
       JOIN tbl_vendor_hotel_category_subscription h
         ON h.vendor_id = ANY($1::int[])
        AND h.item_type = 'hotel'
        AND h.item_id = ANY($3::int[])
        AND h.status = 'active'
      WHERE c.vendor_id = ANY($1::int[])
        AND c.item_type = 'category'
        AND c.item_id = $2
        AND c.status = 'active'
      LIMIT 1`,
    [holderIds, Number(category_id), hotels]
  );
  return !!row;
}

export default { resolveArcVendorCoverage, vendorCanSubmitForHotels };
