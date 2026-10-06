// Hotel location ids (Vendor Networks spec §3, "Hotel location backfill").
//
// tbl_hospitality_company_hotels keeps free-text `state` / `city`; coverage rules key on
// tbl_location_states / tbl_location_cities ids. resolveHotelLocationIds keeps the
// state_id / city_id columns in sync on every hotel write, so the hotel forms need no change.
//
// The matching rule MUST equal the migration's vn_backfill_hotel_location_ids()
// (migrations/20261006100000_vendor_networks.sql):
//   - state: lower(trim(state_name)) among India states (country_id = 1), only when that
//     normalised name is unique there;
//   - city: lower(trim(city_name)) within the resolved state, only when unique in that state;
//   - ambiguous or unknown names stay NULL; no state => no city.
// tests/services/vendorNetwork.coverage.test.js "parity with vn_backfill_hotel_location_ids"
// runs both on the same hotels.

import db from "../config/dbConn.js";

/**
 * Location ids for a hotel's free-text state and city.
 * @returns {Promise<{ state_id: number|null, city_id: number|null }>}
 */
export async function resolveHotelLocationIds(stateText, cityText, runner = db) {
  const row = await runner.one(
    `WITH s AS (
       SELECT min(id) AS id
         FROM tbl_location_states
        WHERE country_id = 1
        GROUP BY lower(trim(state_name))
       HAVING count(*) = 1 AND lower(trim(state_name)) = lower(trim($1::text))
     ),
     c AS (
       SELECT min(c.id) AS id
         FROM tbl_location_cities c
         JOIN s ON c.state_id = s.id
        GROUP BY c.state_id, lower(trim(c.city_name))
       HAVING count(*) = 1 AND lower(trim(c.city_name)) = lower(trim($2::text))
     )
     SELECT (SELECT id FROM s) AS state_id, (SELECT id FROM c) AS city_id`,
    [stateText ?? null, cityText ?? null]
  );
  return { state_id: row.state_id ?? null, city_id: row.city_id ?? null };
}

/**
 * Live hotels (is_deleted = 0) without a state_id or city_id, with why:
 *   NO_STATE_TEXT | STATE_UNMATCHED | NO_CITY_TEXT | CITY_UNMATCHED.
 * Such hotels are matched by coverage rules only partly (no city_id: STATE and HOTEL
 * rules) or not at all by location (no state_id: HOTEL rules only).
 */
export function findUnmatchedHotels(runner = db) {
  return runner.any(
    `SELECT h.id, h.name, h.hospitality_company_id, h.state, h.city, h.state_id, h.city_id,
            CASE
              WHEN h.state_id IS NULL AND NULLIF(trim(h.state), '') IS NULL THEN 'NO_STATE_TEXT'
              WHEN h.state_id IS NULL THEN 'STATE_UNMATCHED'
              WHEN NULLIF(trim(h.city), '') IS NULL THEN 'NO_CITY_TEXT'
              ELSE 'CITY_UNMATCHED'
            END AS reason
       FROM tbl_hospitality_company_hotels h
      WHERE COALESCE(h.is_deleted, 0) = 0
        AND (h.state_id IS NULL OR h.city_id IS NULL)
      ORDER BY h.id`
  );
}

export default { resolveHotelLocationIds, findUnmatchedHotels };
