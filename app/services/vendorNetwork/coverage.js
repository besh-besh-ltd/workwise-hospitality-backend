// Vendor Networks coverage (spec §6.1): which member entities can serve which hotels.
//
// Decision, per entity and hotel (one SQL statement for any number of both):
//   R     = the entity's rules with category_id NULL or = categoryId
//   M     = rules in R matching the hotel: HOTEL on hotel.id, CITY on hotel.city_id,
//           STATE on hotel.state_id (a NULL location id matches nothing, so a hotel
//           without ids is reachable by HOTEL rules only, never "by everything")
//   top   = max specificity in M (HOTEL 3 > CITY 2 > STATE 1); M empty => not covered
//   T     = rules of M at top; category-specific ones win over category-NULL ones
//   covered = no rule in T is EXCLUDE
// Ordering M by (specificity desc, category-specific first, EXCLUDE first) makes the first
// row the deciding rule: covered <=> that row is INCLUDE. DECIDING_RULES_SQL is that.
//
// Candidates are the org's ACTIVE, non-principal entities that may operate: the SQL twin of
// actingContext.entityCanOperate (ACTIVE, plus an active seat ending >= today in IST when
// NETWORK_SEAT_FEE_INR > 0). tests/services/vendorNetwork.coverage.test.js pins the parity.

import db from "../../config/dbConn.js";
import { istDate, seatFeeInr } from "../../constants/vendorNetwork.js";

/** Most hotels a coverage preview evaluates. */
export const PREVIEW_HOTEL_CAP = 2000;

const toIds = (ids) =>
  [...new Set((ids ?? []).map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647);

/**
 * Deciding rule rows (vendor_id, hotel_id, mode, specificity) for every pair of an entity
 * in CTE `ents(vendor_id)` and a hotel in CTE `hs(id, state_id, city_id)` that some rule
 * matches. `$categoryParam` is the category id placeholder (NULL = category-NULL rules only).
 */
const decidingRulesSql = (categoryParam) => `
  SELECT DISTINCT ON (r.entity_vendor_id, hs.id)
         r.entity_vendor_id AS vendor_id, hs.id AS hotel_id, r.mode,
         CASE r.scope_type WHEN 'HOTEL' THEN 3 WHEN 'CITY' THEN 2 ELSE 1 END AS specificity
    FROM ents
    JOIN tbl_vendor_coverage_rules r
      ON r.entity_vendor_id = ents.vendor_id
     AND (r.category_id IS NULL OR r.category_id = ${categoryParam}::int)
    JOIN hs
      ON (r.scope_type = 'HOTEL' AND r.scope_id = hs.id)
      OR (r.scope_type = 'CITY'  AND r.scope_id = hs.city_id)
      OR (r.scope_type = 'STATE' AND r.scope_id = hs.state_id)
   ORDER BY r.entity_vendor_id, hs.id,
            CASE r.scope_type WHEN 'HOTEL' THEN 3 WHEN 'CITY' THEN 2 ELSE 1 END DESC,
            (r.category_id IS NOT NULL) DESC,
            (r.mode = 'EXCLUDE') DESC`;

/**
 * The org's member entities that may be assigned work: ACTIVE, not the principal, and
 * seated when seats cost money. Placeholders: org id, fee-free flag, IST date.
 */
const operableCandidatesSql = (orgParam, feeFreeParam, todayParam) => `
  SELECT e.vendor_id, e.preference_rank, u.name
    FROM tbl_vendor_org_entities e
    JOIN tbl_vendor_orgs o ON o.id = e.org_id
    JOIN tbl_users u ON u.id = e.vendor_id
   WHERE e.org_id = ${orgParam} AND e.status = 'ACTIVE'
     AND e.relationship <> 'PRINCIPAL' AND e.vendor_id <> o.principal_vendor_id
     AND (${feeFreeParam}::boolean OR EXISTS (
           SELECT 1 FROM tbl_vendor_network_seats s
            WHERE s.entity_vendor_id = e.vendor_id AND s.org_id = e.org_id
              AND s.status = 'active' AND s.end_date >= ${todayParam}::date))`;

/**
 * Ranked member entities of `orgId` covering at least one of `hotelIds` for `categoryId`:
 * [{ entity_vendor_id, name, specificity, preference_rank, covers_all_hotels, hotels_covered }]
 * specificity is the highest deciding INCLUDE rule over the covered hotels. Ranked by
 * covers_all_hotels desc, specificity desc, preference_rank asc, entity_vendor_id asc.
 */
export async function resolveCoverageCandidates({ orgId, hotelIds, categoryId = null }, runner = db) {
  const ids = toIds(hotelIds);
  if (!ids.length || !orgId) return [];
  const rows = await runner.any(
    `WITH ents AS (${operableCandidatesSql("$1", "$4", "$5")}),
          hs AS (SELECT id, state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = ANY($2::int[])),
          decided AS (${decidingRulesSql("$3")})
     SELECT ents.vendor_id AS entity_vendor_id, ents.name,
            max(d.specificity)::int AS specificity, ents.preference_rank,
            count(*) = cardinality($2::int[]) AS covers_all_hotels,
            array_agg(d.hotel_id ORDER BY d.hotel_id) AS hotels_covered
       FROM decided d
       JOIN ents ON ents.vendor_id = d.vendor_id
      WHERE d.mode = 'INCLUDE'
      GROUP BY ents.vendor_id, ents.name, ents.preference_rank
      ORDER BY covers_all_hotels DESC, specificity DESC, ents.preference_rank ASC, ents.vendor_id ASC`,
    [orgId, ids, categoryId ?? null, seatFeeInr() === 0, istDate()]
  );
  return rows.map((r) => ({ ...r, hotels_covered: r.hotels_covered.map(Number) }));
}

/**
 * Whether one entity's rules cover one hotel for `categoryId`.
 * specificity is that of the deciding rule (0 when no rule matches), whatever its mode.
 * Rules only: seat and status gates are resolveCoverageCandidates' job.
 */
export async function entityCoversHotel(entityVendorId, hotelId, categoryId = null, runner = db) {
  const row = await runner.oneOrNone(
    `WITH ents AS (SELECT $1::int AS vendor_id),
          hs AS (SELECT id, state_id, city_id FROM tbl_hospitality_company_hotels WHERE id = $2)
     ${decidingRulesSql("$3")}`,
    [entityVendorId, hotelId, categoryId ?? null]
  );
  if (!row) return { covered: false, specificity: 0 };
  return { covered: row.mode === "INCLUDE", specificity: Number(row.specificity) };
}

/**
 * The preview hotel set of an org (spec simplification): live hotels of any PUBLISHED RFQ
 * (tbl_rfq.hotel_id or tbl_rfq_hotel_mappings) the principal was invited to through
 * tbl_rfq_product_vendors, or of any floated ARC (lead hotel or tbl_arc_hotel_mappings)
 * with a tbl_arc_invitation for it. Lowest ids first, at most PREVIEW_HOTEL_CAP.
 *
 * Published only (audit L4): saveRfqDraft writes tbl_rfq_product_vendors rows for drafts,
 * and a buyer's unpublished draft (or a terminated / withdrawn RFQ, is_published = 0) must
 * never put its hotel names in front of a vendor. A deleted RFQ row is gone. An ARC
 * still in 'draft' has invited no one yet.
 */
const previewHotelIdsSql = (principalParam) => `
  SELECT h.id, h.name, h.city, h.state, h.state_id, h.city_id
    FROM tbl_hospitality_company_hotels h
   WHERE COALESCE(h.is_deleted, 0) = 0
     AND h.id IN (
       WITH invited_rfqs AS (
         SELECT r.id, r.hotel_id FROM tbl_rfq r
          WHERE r.is_published = 1
            AND r.id IN (SELECT rfq_id FROM tbl_rfq_product_vendors WHERE user_id = ${principalParam})
       ),
       invited_arcs AS (
         SELECT a.id, a.hotel_id FROM tbl_arc a
          WHERE a.status <> 'draft'
            AND a.id IN (SELECT arc_id FROM tbl_arc_invitation WHERE vendor_id = ${principalParam})
       )
       SELECT hotel_id FROM invited_rfqs
       UNION
       SELECT m.hotel_id FROM tbl_rfq_hotel_mappings m WHERE m.rfq_id IN (SELECT id FROM invited_rfqs)
       UNION
       SELECT hotel_id FROM invited_arcs
       UNION
       SELECT am.hotel_id FROM tbl_arc_hotel_mappings am WHERE am.arc_id IN (SELECT id FROM invited_arcs))
   ORDER BY h.id
   LIMIT ${PREVIEW_HOTEL_CAP + 1}`;

/** The preview hotel set as offered and validated: the first PREVIEW_HOTEL_CAP of it. */
const cappedPreviewSql = (principalParam) =>
  `SELECT * FROM (${previewHotelIdsSql(principalParam)}) pv ORDER BY id LIMIT ${PREVIEW_HOTEL_CAP}`;

/**
 * Rules of an entity, most specific first. A HOTEL rule's scope_name resolves only for
 * hotels in the org's preview set (PUT never stores others; this guards it anyway).
 */
export function listCoverageRules(entityVendorId, principalVendorId, runner = db) {
  return runner.any(
    `WITH preview AS (${cappedPreviewSql("$2")})
     SELECT r.id, r.scope_type, r.scope_id, r.mode, r.category_id, r.created_by, r.created_at,
            CASE r.scope_type
              WHEN 'STATE' THEN st.state_name
              WHEN 'CITY'  THEN ct.city_name
              ELSE h.name
            END AS scope_name,
            cat.title AS category_name
       FROM tbl_vendor_coverage_rules r
       LEFT JOIN tbl_location_states st ON r.scope_type = 'STATE' AND st.id = r.scope_id
       LEFT JOIN tbl_location_cities ct ON r.scope_type = 'CITY' AND ct.id = r.scope_id
       LEFT JOIN preview h ON r.scope_type = 'HOTEL' AND h.id = r.scope_id
       LEFT JOIN tbl_category cat ON cat.id = r.category_id
      WHERE r.entity_vendor_id = $1
      ORDER BY CASE r.scope_type WHEN 'HOTEL' THEN 1 WHEN 'CITY' THEN 2 ELSE 3 END,
               r.scope_id, r.category_id NULLS FIRST, r.id`,
    [entityVendorId, principalVendorId]
  );
}

/**
 * Of the given rules, the targets that are not allowed:
 *   scopes:     STATE / CITY ids that do not exist (STATE must be an India state)
 *   categories: category ids that are not live categories
 *   hotelsOutsideNetwork: true when any HOTEL id is not in the org's capped preview set.
 * Locations and categories are public master data, so they are listed; hotels are only
 * a flag, so a refusal never reveals whether another tenant's hotel id exists.
 */
export async function findInvalidRuleTargets(rules, principalVendorId, runner = db) {
  const idsOf = (type) => toIds(rules.filter((r) => r.scope_type === type).map((r) => r.scope_id));
  const categoryIds = toIds(rules.map((r) => r.category_id).filter((c) => c != null));
  const row = await runner.one(
    `WITH preview AS (${cappedPreviewSql("$5")})
     SELECT
       ARRAY(SELECT x FROM unnest($1::int[]) x
              WHERE NOT EXISTS (SELECT 1 FROM tbl_location_states s WHERE s.id = x AND s.country_id = 1)) AS states,
       ARRAY(SELECT x FROM unnest($2::int[]) x
              WHERE NOT EXISTS (SELECT 1 FROM tbl_location_cities c WHERE c.id = x)) AS cities,
       EXISTS (SELECT 1 FROM unnest($3::int[]) x
                WHERE NOT EXISTS (SELECT 1 FROM preview p WHERE p.id = x)) AS hotels_outside,
       ARRAY(SELECT x FROM unnest($4::int[]) x
              WHERE NOT EXISTS (SELECT 1 FROM tbl_category c
                                 WHERE c.id = x AND COALESCE(c.is_deleted, 0) = 0)) AS categories`,
    [idsOf("STATE"), idsOf("CITY"), idsOf("HOTEL"), categoryIds, principalVendorId]
  );
  return {
    scopes: [
      ...row.states.map((id) => ({ scope_type: "STATE", scope_id: Number(id) })),
      ...row.cities.map((id) => ({ scope_type: "CITY", scope_id: Number(id) })),
    ],
    categories: row.categories.map(Number),
    hotelsOutsideNetwork: row.hotels_outside,
  };
}

/** Replaces every rule of an entity with `rules` (call inside a transaction). */
export async function replaceCoverageRules(entityVendorId, rules, createdBy, runner) {
  await runner.none(`DELETE FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [entityVendorId]);
  if (!rules.length) return;
  await runner.none(
    `INSERT INTO tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, mode, category_id, created_by)
     SELECT $1, t.scope_type, t.scope_id, t.mode, t.category_id, $6
       FROM unnest($2::text[], $3::int[], $4::text[], $5::int[]) AS t(scope_type, scope_id, mode, category_id)`,
    [
      entityVendorId,
      rules.map((r) => r.scope_type),
      rules.map((r) => r.scope_id),
      rules.map((r) => r.mode),
      rules.map((r) => r.category_id),
      createdBy,
    ]
  );
}

/**
 * Which preview-set hotels the entity's rules cover for `categoryId`:
 * { hotels_considered, truncated, covered: [{ id, name, city, state, specificity }] }.
 */
export async function previewCoveredHotels({ principalVendorId, entityVendorId, categoryId = null }, runner = db) {
  const rows = await runner.any(
    `WITH preview AS (${previewHotelIdsSql("$1")}),
          hs AS (SELECT id, state_id, city_id FROM preview ORDER BY id LIMIT ${PREVIEW_HOTEL_CAP}),
          ents AS (SELECT $2::int AS vendor_id),
          decided AS (${decidingRulesSql("$3")})
     SELECT p.id, p.name, p.city, p.state, d.specificity, d.mode,
            (SELECT count(*) FROM preview)::int AS preview_count
       FROM preview p
       LEFT JOIN decided d ON d.hotel_id = p.id
      ORDER BY p.id
      LIMIT ${PREVIEW_HOTEL_CAP}`,
    [principalVendorId, entityVendorId, categoryId ?? null]
  );
  const previewCount = rows.length ? rows[0].preview_count : 0;
  return {
    hotels_considered: rows.length,
    truncated: previewCount > PREVIEW_HOTEL_CAP,
    covered: rows
      .filter((r) => r.mode === "INCLUDE")
      .map(({ id, name, city, state, specificity }) => ({ id, name, city, state, specificity })),
  };
}

/** Preview-set hotels whose name contains `q` (case-insensitive), at most `limit`. */
export function searchPreviewHotels({ principalVendorId, q = "", limit = 50 }, runner = db) {
  return runner.any(
    `WITH preview AS (${cappedPreviewSql("$1")})
     SELECT p.id, p.name, p.city, p.state, p.state_id, p.city_id
       FROM preview p
      WHERE $2 = '' OR p.name ILIKE '%' || $2 || '%'
      ORDER BY p.name, p.id
      LIMIT $3`,
    [principalVendorId, q.replace(/[\\%_]/g, (c) => `\\${c}`), limit]
  );
}

/** India states for HOTEL/CITY/STATE pickers. */
export function listIndiaStates(runner = db) {
  return runner.any(
    `SELECT id, state_name AS name FROM tbl_location_states WHERE country_id = 1 ORDER BY state_name, id`
  );
}

/** Cities of one India state. */
export function listCitiesOfState(stateId, runner = db) {
  return runner.any(
    `SELECT c.id, c.city_name AS name
       FROM tbl_location_cities c
       JOIN tbl_location_states s ON s.id = c.state_id AND s.country_id = 1
      WHERE c.state_id = $1
      ORDER BY c.city_name, c.id`,
    [stateId]
  );
}

export default {
  PREVIEW_HOTEL_CAP,
  resolveCoverageCandidates,
  entityCoversHotel,
  listCoverageRules,
  findInvalidRuleTargets,
  replaceCoverageRules,
  previewCoveredHotels,
  searchPreviewHotels,
  listIndiaStates,
  listCitiesOfState,
};
