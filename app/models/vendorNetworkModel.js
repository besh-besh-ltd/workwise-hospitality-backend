// Vendor Networks reads (spec 2026-10-06-vendor-networks-design.md, §3-§5).
// Every function takes `runner` (db or a tx) last. "Live" entity = status <> 'REMOVED';
// the partial unique index ix_vn_entities_live_vendor makes vendor_id lookups exact.

import db from "../config/dbConn.js";
import { istDate, VENDOR_MEMBER_USER_TYPE } from "../constants/vendorNetwork.js";
import { activeSiblingIdsSql } from "../services/vendorNetwork/orgKeySql.js";

/** The live org membership of an entity, with its org: null when the vendor is in no org. */
export function getOrgByEntity(vendorId, runner = db) {
  return runner.oneOrNone(
    `SELECT e.org_id, e.vendor_id, e.relationship, e.status AS entity_status,
            o.name AS org_name, o.principal_vendor_id, o.routing_mode, o.routing_timeout_hours
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_orgs o ON o.id = e.org_id
      WHERE e.vendor_id = $1 AND e.status <> 'REMOVED'`,
    [vendorId]
  );
}

export function getOrgById(id, runner = db) {
  return runner.oneOrNone(`SELECT * FROM tbl_vendor_orgs WHERE id = $1`, [id]);
}

/** The live entity row of `vendorId` inside `orgId`, or null. */
export function getEntity(orgId, vendorId, runner = db) {
  return runner.oneOrNone(
    `SELECT * FROM tbl_vendor_org_entities
      WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'`,
    [orgId, vendorId]
  );
}

/** Live entities of an org with their login state, principal first, then by vendor id. */
export function listEntities(orgId, runner = db) {
  return runner.any(
    `SELECT e.*, u.name, u.email, u.status AS user_status, COALESCE(u.is_deleted, 0) AS user_is_deleted
       FROM tbl_vendor_org_entities e
       JOIN tbl_users u ON u.id = e.vendor_id
      WHERE e.org_id = $1 AND e.status <> 'REMOVED'
      ORDER BY (e.relationship = 'PRINCIPAL') DESC, e.vendor_id`,
    [orgId]
  );
}

/** ACTIVE memberships of a person, with org name and principal. */
export function getActiveMemberships(personId, runner = db) {
  return runner.any(
    `SELECT m.*, o.name AS org_name, o.principal_vendor_id
       FROM tbl_vendor_org_members m
       JOIN tbl_vendor_orgs o ON o.id = m.org_id
      WHERE m.person_user_id = $1 AND m.status = 'ACTIVE'
      ORDER BY m.org_id, m.entity_vendor_id NULLS FIRST`,
    [personId]
  );
}

/** The current active seat of an entity in its live org (end_date >= today in IST), or null. */
export function getActiveSeat(entityId, runner = db, today = istDate()) {
  return runner.oneOrNone(
    `SELECT s.*
       FROM tbl_vendor_network_seats s
       JOIN tbl_vendor_org_entities e
         ON e.vendor_id = s.entity_vendor_id AND e.org_id = s.org_id AND e.status <> 'REMOVED'
      WHERE s.entity_vendor_id = $1 AND s.status = 'active' AND s.end_date >= $2::date
      ORDER BY s.end_date DESC
      LIMIT 1`,
    [entityId, today]
  );
}

/**
 * What a member entity's hospitality subscription standing rests on (spec §5.1, §5.2), for
 * the subscription-status / profile surfaces: its live org row, the org's principal, the
 * entity's seat, and the latest end date of a valid subscription among the org's holders.
 * The holder set and the validity predicate are hasValidPaidSubscription's, so the dates
 * shown match what the subscription gate decides. null when the vendor is in no org.
 */
export function getNetworkSubscriptionStanding(vendorId, runner = db, today = istDate()) {
  return runner.oneOrNone(
    `SELECT e.org_id, o.name AS org_name, e.relationship, e.status AS entity_status,
            o.principal_vendor_id, COALESCE(pc.company_name, pu.name) AS principal_name,
            (SELECT MAX(s.end_date) FROM tbl_vendor_network_seats s
              WHERE s.entity_vendor_id = e.vendor_id AND s.org_id = e.org_id
                AND s.status = 'active' AND s.end_date >= $2::date)::text AS seat_valid_until,
            (SELECT MAX(s.end_date) FROM tbl_vendor_network_seats s
              WHERE s.entity_vendor_id = e.vendor_id AND s.org_id = e.org_id
                AND s.status IN ('active', 'expired'))::text AS last_seat_end,
            (SELECT MAX(vhcs.end_date)
               FROM tbl_vendor_hotel_category_subscription vhcs
               LEFT JOIN tbl_vendor_payments vp ON vp.id = vhcs.payment_id
              WHERE vhcs.vendor_id IN (${activeSiblingIdsSql("$1")})
                AND vhcs.status = 'active'
                AND vhcs.end_date >= CURRENT_DATE
                AND (vp.payment_status IN ('paid', 'success') OR vhcs.payment_id IS NULL)
            )::date::text AS subscription_valid_until
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_orgs o ON o.id = e.org_id
       JOIN tbl_users pu ON pu.id = o.principal_vendor_id
       LEFT JOIN tbl_company pc ON pc.id = pu.company_id
      WHERE e.vendor_id = $1 AND e.status <> 'REMOVED'`,
    [vendorId, today]
  );
}

/**
 * Every entity a type-11 person may act as, in one query: ACTIVE memberships joined to
 * the ACTIVE, logged-in-able (status 1, not deleted, user_type 3) entities they cover.
 * ORG_ADMIN covers every ACTIVE entity of its org; ENTITY_MEMBER covers its own entity.
 * One row per entity; an ORG_ADMIN grant wins over an ENTITY_MEMBER grant. Ordered by vendor_id.
 */
export function listActableForPerson(personId, runner = db) {
  return runner.any(
    `SELECT DISTINCT ON (e.vendor_id)
            e.vendor_id, e.relationship, e.org_id, m.role, u.name,
            o.name AS org_name, o.principal_vendor_id
       FROM tbl_vendor_org_members m
       JOIN tbl_vendor_orgs o ON o.id = m.org_id
       JOIN tbl_vendor_org_entities e
         ON e.org_id = m.org_id AND e.status = 'ACTIVE'
        AND (m.role = 'ORG_ADMIN' OR e.vendor_id = m.entity_vendor_id)
       JOIN tbl_users u
         ON u.id = e.vendor_id AND u.user_type = 3 AND u.status = 1 AND COALESCE(u.is_deleted, 0) = 0
      WHERE m.person_user_id = $1 AND m.status = 'ACTIVE' AND m.status <> 'DISABLED'
      ORDER BY e.vendor_id, (m.role = 'ORG_ADMIN') DESC`,
    [personId]
  );
}

/**
 * The full tbl_users row of a would-be acting entity plus its live org placement, or null
 * unless it is a type-3 user with status 1, not deleted, and live in some org.
 * Org fields come back as `vn_org_id`, `vn_entity_status`, `vn_relationship`.
 */
export function getActingEntityRow(vendorId, runner = db) {
  return runner.oneOrNone(
    `SELECT u.*, e.org_id AS vn_org_id, e.status AS vn_entity_status, e.relationship AS vn_relationship
       FROM tbl_users u
       JOIN tbl_vendor_org_entities e ON e.vendor_id = u.id AND e.status <> 'REMOVED'
      WHERE u.id = $1 AND u.user_type = 3 AND u.status = 1 AND COALESCE(u.is_deleted, 0) = 0`,
    [vendorId]
  );
}

/**
 * Ids of the ACTIVE entities of the vendor's org whose login is live (status 1, not deleted),
 * when the vendor itself is ACTIVE there.
 */
export async function listActiveSiblingIds(vendorId, runner = db) {
  const rows = await runner.any(`${activeSiblingIdsSql("$1")} ORDER BY ns_e2.vendor_id`, [vendorId]);
  return rows.map((r) => r.vendor_id);
}

/** Distinct ids with every ACTIVE/SUSPENDED org entity replaced by its org's principal, ascending. */
export async function mapToPrincipalIds(vendorIds, runner = db) {
  // `<> 'REMOVED'` keeps the partial index ix_vn_entities_live_vendor usable.
  const rows = await runner.any(
    `SELECT DISTINCT COALESCE(o.principal_vendor_id, v.id) AS id
       FROM unnest($1::int[]) AS v(id)
       LEFT JOIN tbl_vendor_org_entities e
         ON e.vendor_id = v.id AND e.status <> 'REMOVED' AND e.status IN ('ACTIVE', 'SUSPENDED')
       LEFT JOIN tbl_vendor_orgs o ON o.id = e.org_id
      WHERE v.id IS NOT NULL
      ORDER BY 1`,
    [vendorIds]
  );
  return rows.map((r) => r.id);
}

/** Entity placement plus a has-current-seat flag (IST `today`), in one query; null for a vendor in no org. */
export function getOperateState(vendorId, runner = db, today = istDate()) {
  return runner.oneOrNone(
    `SELECT e.org_id, e.relationship, e.status AS entity_status, o.principal_vendor_id,
            EXISTS (
              SELECT 1 FROM tbl_vendor_network_seats s
               WHERE s.entity_vendor_id = e.vendor_id AND s.org_id = e.org_id
                 AND s.status = 'active' AND s.end_date >= $2::date
            ) AS has_seat
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_orgs o ON o.id = e.org_id
      WHERE e.vendor_id = $1 AND e.status <> 'REMOVED'`,
    [vendorId, today]
  );
}

/**
 * Persons who can act for each of `entityIds` and should get its web-push (spec §4.4):
 * ACTIVE ENTITY_MEMBER memberships on the entity, plus ACTIVE ORG_ADMIN persons of the
 * org when the entity is the principal. Only ACTIVE entities with a live login, only live
 * persons; the entity itself is excluded. Rows: { entity_id, person_user_id }.
 */
export function listPushDelegates(entityIds, runner = db) {
  return runner.any(
    `SELECT DISTINCT e.vendor_id AS entity_id, m.person_user_id
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_orgs o ON o.id = e.org_id
       JOIN tbl_users eu
         ON eu.id = e.vendor_id AND eu.status = 1 AND COALESCE(eu.is_deleted, 0) = 0
       JOIN tbl_vendor_org_members m ON m.org_id = e.org_id AND m.status = 'ACTIVE'
       JOIN tbl_users pu
         ON pu.id = m.person_user_id AND pu.status = 1 AND COALESCE(pu.is_deleted, 0) = 0
      -- <> 'REMOVED' keeps the partial index ix_vn_entities_live_vendor usable.
      WHERE e.vendor_id = ANY($1::int[]) AND e.status <> 'REMOVED' AND e.status = 'ACTIVE'
        AND m.person_user_id <> e.vendor_id
        AND ((m.role = 'ENTITY_MEMBER' AND m.entity_vendor_id = e.vendor_id)
          OR (m.role = 'ORG_ADMIN' AND e.vendor_id = o.principal_vendor_id))
      ORDER BY 1, 2`,
    [entityIds]
  );
}

/**
 * True when `userId` is a live, non-principal network entity with no password of its own:
 * a login created for the network that people reach only through memberships (spec §4.2).
 */
export async function isNetworkManagedLogin(userId, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT 1
       FROM tbl_vendor_org_entities e
       JOIN tbl_users u ON u.id = e.vendor_id
      WHERE e.vendor_id = $1 AND e.status <> 'REMOVED' AND e.relationship <> 'PRINCIPAL'
        AND u.password IS NULL`,
    [userId]
  );
  return !!row;
}

// ---------------------------------------------------------------------------
// Org and entity management (Task 4, spec §5).
// ---------------------------------------------------------------------------

/** Creates an org with `principalVendorId` as its ACTIVE PRINCIPAL entity and `personId` as ORG_ADMIN. */
export async function createOrgWithPrincipal({ name, principalVendorId, personId }, runner = db) {
  const org = await runner.one(
    `INSERT INTO tbl_vendor_orgs (name, principal_vendor_id, created_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [name, principalVendorId, personId]
  );
  await runner.none(
    `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, invited_by, linked_at)
     VALUES ($1, $2, 'PRINCIPAL', 'ACTIVE', $3, now())`,
    [org.id, principalVendorId, personId]
  );
  await runner.none(
    `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status, invited_by)
     VALUES ($1, $2, NULL, 'ORG_ADMIN', 'ACTIVE', $2)`,
    [org.id, personId]
  );
  return org;
}

/** Updates the given settings columns (name, routing_mode, routing_timeout_hours) of an org. */
export function updateOrgSettings(orgId, { name, routing_mode, routing_timeout_hours }, runner = db) {
  return runner.one(
    `UPDATE tbl_vendor_orgs
        SET name = COALESCE($2, name),
            routing_mode = COALESCE($3, routing_mode),
            routing_timeout_hours = COALESCE($4, routing_timeout_hours),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [orgId, name ?? null, routing_mode ?? null, routing_timeout_hours ?? null]
  );
}

/**
 * Live entities with their login and seat, principal first. DISPLAY ONLY: no gate reads
 * this (gates use getOperateState / entityCanOperate).
 *
 * seat_status: the current seat's status ('active' wins over 'pending'); when the entity
 * has no current seat but an earlier one ran out (its FY ended, or it was marked
 * expired), 'expired' with that seat; NULL when it never had one (or only cancelled
 * ones). seat_valid_until is the shown seat's end date as 'YYYY-MM-DD'. Whether an expired seat matters
 * depends on the fee: at 0 it blocks nothing (the FE shows "Included", see seat_fee_inr).
 */
export function listEntitiesWithSeats(orgId, runner = db, today = istDate()) {
  return runner.any(
    `SELECT e.vendor_id, e.relationship, e.status, e.preference_rank, e.linked_at,
            u.name, u.email, u.status AS user_status,
            s.id AS seat_id,
            CASE WHEN s.id IS NULL THEN NULL WHEN s.is_current THEN s.status ELSE 'expired' END AS seat_status,
            s.end_date AS seat_end_date, s.end_date::text AS seat_valid_until, s.fee_amount AS seat_fee_amount
       FROM tbl_vendor_org_entities e
       JOIN tbl_users u ON u.id = e.vendor_id
       LEFT JOIN LATERAL (
         SELECT id, status, end_date, fee_amount,
                (status IN ('active', 'pending') AND end_date >= $2::date) AS is_current
           FROM tbl_vendor_network_seats
          WHERE org_id = e.org_id AND entity_vendor_id = e.vendor_id
            AND (
              (status IN ('active', 'pending') AND end_date >= $2::date)
              OR status = 'expired'
              OR (status = 'active' AND end_date < $2::date)
            )
          ORDER BY (status IN ('active', 'pending') AND end_date >= $2::date) DESC,
                   (status = 'active') DESC, end_date DESC, id DESC
          LIMIT 1
       ) s ON true
      WHERE e.org_id = $1 AND e.status <> 'REMOVED'
      ORDER BY (e.relationship = 'PRINCIPAL') DESC, e.vendor_id`,
    [orgId, today]
  );
}

/**
 * Memberships of an org with each person's name and email and the entity's name;
 * DISABLED ones only with `includeDisabled`. Never exposes the invite token hash.
 */
export function listMembers(orgId, runner = db, { includeDisabled = false } = {}) {
  return runner.any(
    `SELECT m.id, m.person_user_id, m.entity_vendor_id, m.role, m.status, m.invite_expires_at,
            u.name, u.email, eu.name AS entity_name
       FROM tbl_vendor_org_members m
       JOIN tbl_users u ON u.id = m.person_user_id
       LEFT JOIN tbl_users eu ON eu.id = m.entity_vendor_id
      WHERE m.org_id = $1 AND ($2 OR m.status <> 'DISABLED')
      ORDER BY m.role, m.id`,
    [orgId, includeDisabled]
  );
}

/** The 10-char PAN of a vendor: chars 3-12 of its company GSTIN, else its PAN document. */
export async function getVendorPan(vendorId, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT COALESCE(
              NULLIF(upper(substr(trim(c.gstin), 3, 10)), ''),
              (SELECT upper(trim(d.document_number)) FROM tbl_vendor_documents d
                WHERE d.vendor_id = u.id AND d.document_type = 'pan'
                  AND NULLIF(trim(d.document_number), '') IS NOT NULL
                ORDER BY d.id DESC LIMIT 1)
            ) AS pan
       FROM tbl_users u
       LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE u.id = $1`,
    [vendorId]
  );
  return row?.pan && row.pan.length === 10 ? row.pan : null;
}

/** Live (non-REMOVED) entity rows of an org, the principal included. */
export async function countLiveEntities(orgId, runner = db) {
  const row = await runner.one(
    `SELECT count(*)::int AS n FROM tbl_vendor_org_entities WHERE org_id = $1 AND status <> 'REMOVED'`,
    [orgId]
  );
  return row.n;
}

/** Active type-3 vendors (not `excludeVendorId`) sharing `pan` that are live in no org. */
export function listVendorsByPan(pan, excludeVendorId, runner = db) {
  return runner.any(
    `SELECT u.id AS vendor_id, u.name, u.email, c.company_name, c.gstin
       FROM tbl_users u
       LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE u.user_type = 3 AND u.status = 1 AND COALESCE(u.is_deleted, 0) = 0
        AND u.id <> $2
        AND (upper(substr(trim(c.gstin), 3, 10)) = $1
             OR EXISTS (SELECT 1 FROM tbl_vendor_documents d
                         WHERE d.vendor_id = u.id AND d.document_type = 'pan'
                           AND upper(trim(d.document_number)) = $1))
        AND NOT EXISTS (SELECT 1 FROM tbl_vendor_org_entities e
                         WHERE e.vendor_id = u.id AND e.status <> 'REMOVED')
      ORDER BY u.id`,
    [pan, excludeVendorId]
  );
}

/** An active type-3 vendor by id or by exact (case-insensitive) email, or null. */
export function findActiveVendor({ vendorId = null, email = null }, runner = db) {
  return runner.oneOrNone(
    `SELECT id, name, email FROM tbl_users
      WHERE user_type = 3 AND status = 1 AND COALESCE(is_deleted, 0) = 0
        AND ${vendorId != null ? "id = $1" : "lower(email) = lower($1)"}
      ORDER BY id
      LIMIT 1`,
    [vendorId ?? email]
  );
}

/** True when the vendor is the principal of any org. */
export async function isPrincipalOfAnyOrg(vendorId, runner = db) {
  return !!(await runner.oneOrNone(`SELECT 1 FROM tbl_vendor_orgs WHERE principal_vendor_id = $1`, [vendorId]));
}

/**
 * Inserts a PENDING invite. A stale (expired) PENDING invite to the same target is first
 * flipped to EXPIRED so it does not hold the one-PENDING-per-(org, target) index; a live
 * one makes the insert raise 23505.
 */
export async function createLinkInvite(
  { orgId, targetVendorId, relationship, addressedBy, tokenHash, ttlDays, createdBy },
  runner = db
) {
  await runner.none(
    `UPDATE tbl_vendor_org_link_invites SET status = 'EXPIRED', acted_at = now()
      WHERE org_id = $1 AND target_vendor_id = $2 AND status = 'PENDING' AND expires_at <= now()`,
    [orgId, targetVendorId]
  );
  return runner.one(
    `INSERT INTO tbl_vendor_org_link_invites
       (org_id, target_vendor_id, relationship, addressed_by, token_hash, status, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', now() + make_interval(days => $6), $7)
     RETURNING id, org_id, target_vendor_id, relationship, addressed_by, status, expires_at, created_at`,
    [orgId, targetVendorId, relationship, addressedBy, tokenHash, ttlDays, createdBy]
  );
}

/** A link invite with `expired` (expires_at passed), its org name and principal; FOR UPDATE inside a tx. */
export function getLinkInvite(inviteId, runner = db, { forUpdate = false } = {}) {
  return runner.oneOrNone(
    `SELECT i.*, i.expires_at <= now() AS expired, o.name AS org_name, o.principal_vendor_id
       FROM tbl_vendor_org_link_invites i
       JOIN tbl_vendor_orgs o ON o.id = i.org_id
      WHERE i.id = $1
      ${forUpdate ? "FOR UPDATE OF i" : ""}`,
    [inviteId]
  );
}

/** Moves a PENDING invite to `status`; returns false when it was no longer PENDING. */
export async function setLinkInviteStatus(inviteId, status, runner = db) {
  const result = await runner.result(
    `UPDATE tbl_vendor_org_link_invites SET status = $2, acted_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [inviteId, status]
  );
  return result.rowCount === 1;
}

/**
 * PENDING, unexpired invites addressed to a vendor, newest first, with the inviting
 * principal's company name and GSTIN (the inviter's own identity, which the invitee
 * needs to judge consent; nothing else of the principal is returned). Each is NULL when
 * the principal's company has none: never a substitute such as the login name.
 */
export function listIncomingLinkInvites(targetVendorId, runner = db) {
  return runner.any(
    `SELECT i.id, i.org_id, o.name AS org_name, i.relationship, i.status, i.expires_at, i.created_at,
            NULLIF(TRIM(pc.company_name), '') AS principal_company_name,
            NULLIF(TRIM(pc.gstin), '') AS principal_gstin
       FROM tbl_vendor_org_link_invites i
       JOIN tbl_vendor_orgs o ON o.id = i.org_id
       JOIN tbl_users pu ON pu.id = o.principal_vendor_id
       LEFT JOIN tbl_company pc ON pc.id = pu.company_id
      WHERE i.target_vendor_id = $1 AND i.status = 'PENDING' AND i.expires_at > now()
      ORDER BY i.created_at DESC, i.id DESC`,
    [targetVendorId]
  );
}

/**
 * PENDING, unexpired invites an org has sent, newest first. The target's email is shown
 * only when the admin addressed the invite by that email (it already knew it).
 */
export function listOutgoingLinkInvites(orgId, runner = db) {
  return runner.any(
    `SELECT i.id, i.target_vendor_id, u.name AS target_name,
            CASE WHEN i.addressed_by = 'EMAIL' THEN u.email END AS target_email,
            i.addressed_by, i.relationship, i.status, i.expires_at, i.created_at
       FROM tbl_vendor_org_link_invites i
       JOIN tbl_users u ON u.id = i.target_vendor_id
      WHERE i.org_id = $1 AND i.status = 'PENDING' AND i.expires_at > now()
      ORDER BY i.created_at DESC, i.id DESC`,
    [orgId]
  );
}

/** Inserts a live, ACTIVE non-principal entity row. */
export function insertActiveEntity({ orgId, vendorId, relationship, invitedBy }, runner = db) {
  return runner.one(
    `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, invited_by, linked_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, now())
     RETURNING *`,
    [orgId, vendorId, relationship, invitedBy]
  );
}

/** Id of an active type-3 vendor whose company has `gstin` (case-insensitive), or null. */
export async function findActiveVendorByGstin(gstin, runner = db) {
  const row = await runner.oneOrNone(
    `SELECT u.id FROM tbl_users u
       JOIN tbl_company c ON c.id = u.company_id
      WHERE upper(trim(c.gstin)) = upper($1)
        AND u.user_type = 3 AND u.status = 1 AND COALESCE(u.is_deleted, 0) = 0
      LIMIT 1`,
    [gstin]
  );
  return row?.id ?? null;
}

/** True when any tbl_users row has this email (case-insensitive). */
export async function emailExists(email, runner = db) {
  return !!(await runner.oneOrNone(`SELECT 1 FROM tbl_users WHERE lower(email) = lower($1) LIMIT 1`, [email]));
}

/** Whether an Indian state exists, and whether the city (when given) belongs to it. */
export function checkStateCity(stateId, cityId, runner = db) {
  return runner.one(
    `SELECT EXISTS (SELECT 1 FROM tbl_location_states WHERE id = $1 AND country_id = 1) AS state_ok,
            ($2::int IS NULL OR EXISTS (SELECT 1 FROM tbl_location_cities WHERE id = $2 AND state_id = $1)) AS city_ok`,
    [stateId, cityId]
  );
}

/**
 * tbl_company + passwordless type-3 tbl_users + tbl_company_location for a new network entity
 * of org `orgId`. The company inherits the principal's `is_hospitality`: a hospitality
 * vendor's branch is a hospitality vendor, so the hospitality subscription gate and the
 * profile's has_valid_hospitality_subscription evaluate it (over the org's pooled
 * subscriptions, spec §5.2) instead of skipping it as a non-hospitality account.
 */
export async function insertVendorAccount(
  { orgId, companyName, gstin, email, stateId, cityId, address, createdBy },
  runner = db
) {
  const company = await runner.one(
    `INSERT INTO tbl_company (company_name, gstin, is_hospitality)
     VALUES ($1, $2, COALESCE((SELECT pc.is_hospitality
                                 FROM tbl_vendor_orgs o
                                 JOIN tbl_users pu ON pu.id = o.principal_vendor_id
                                 JOIN tbl_company pc ON pc.id = pu.company_id
                                WHERE o.id = $3), 0))
     RETURNING id`,
    [companyName, gstin, orgId]
  );
  const user = await runner.one(
    `INSERT INTO tbl_users (name, email, user_type, status, company_id, password, created_by)
     VALUES ($1, $2, 3, 1, $3, NULL, $4) RETURNING id`,
    [companyName, email, company.id, createdBy]
  );
  await runner.none(
    `INSERT INTO tbl_company_location (company_id, country_id, state_id, city_id, address, created_by)
     VALUES ($1, 1, $2, $3, $4, $5)`,
    [company.id, stateId, cityId, address, createdBy]
  );
  return { vendorId: user.id, companyId: company.id };
}

/** Sets status (and/or preference_rank) of a live entity; returns the row, or null if it is gone. */
export function updateEntity(orgId, vendorId, { status, preferenceRank }, runner = db) {
  return runner.oneOrNone(
    `UPDATE tbl_vendor_org_entities
        SET status = COALESCE($3, status),
            preference_rank = COALESCE($4, preference_rank),
            updated_at = now()
      WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'
      RETURNING *`,
    [orgId, vendorId, status ?? null, preferenceRank ?? null]
  );
}

/**
 * Persons whose only ACTIVE membership anywhere is an ENTITY_MEMBER one on `vendorId`
 * (in `orgId`): suspending or removing that entity leaves them with nothing to act for.
 */
export async function listPersonsOnlyViaEntity(orgId, vendorId, runner = db) {
  const rows = await runner.any(
    `SELECT DISTINCT m.person_user_id
       FROM tbl_vendor_org_members m
      WHERE m.org_id = $1 AND m.entity_vendor_id = $2 AND m.role = 'ENTITY_MEMBER' AND m.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM tbl_vendor_org_members o
           WHERE o.person_user_id = m.person_user_id AND o.status = 'ACTIVE'
             AND o.id <> m.id AND o.entity_vendor_id IS DISTINCT FROM $2
        )
      ORDER BY 1`,
    [orgId, vendorId]
  );
  return rows.map((r) => Number(r.person_user_id));
}

/**
 * Removes a live entity from its org (spec §5): entity REMOVED, its ENTITY_MEMBER
 * memberships DISABLED, its pending seats cancelled, its coverage rules deleted (they are
 * keyed by entity only, so kept rules would route for any org it later joins). Active
 * seats stay to expiry.
 */
export async function removeEntity(orgId, vendorId, runner = db) {
  const removed = await runner.result(
    `UPDATE tbl_vendor_org_entities
        SET status = 'REMOVED', removed_at = now(), updated_at = now()
      WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'`,
    [orgId, vendorId]
  );
  await runner.none(
    `UPDATE tbl_vendor_org_members
        SET status = 'DISABLED', invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
      WHERE org_id = $1 AND entity_vendor_id = $2 AND role = 'ENTITY_MEMBER' AND status <> 'DISABLED'`,
    [orgId, vendorId]
  );
  await runner.none(
    `UPDATE tbl_vendor_network_seats SET status = 'cancelled', updated_at = now()
      WHERE org_id = $1 AND entity_vendor_id = $2 AND status = 'pending'`,
    [orgId, vendorId]
  );
  // Only when it left THIS org now: a stale call must not wipe rules it holds elsewhere.
  if (removed.rowCount > 0) {
    await runner.none(`DELETE FROM tbl_vendor_coverage_rules WHERE entity_vendor_id = $1`, [vendorId]);
  }
}

// ---------------------------------------------------------------------------
// Seats (spec §5.1).
// ---------------------------------------------------------------------------

/** The entity's current pending-or-active seat in `orgId` (active first, IST `today`), or null. */
export function getLiveSeat(orgId, vendorId, runner = db, today = istDate()) {
  return runner.oneOrNone(
    `SELECT * FROM tbl_vendor_network_seats
      WHERE org_id = $1 AND entity_vendor_id = $2
        AND status IN ('active', 'pending') AND end_date >= $3::date
      ORDER BY (status = 'active') DESC, end_date DESC
      LIMIT 1`,
    [orgId, vendorId, today]
  );
}

/** Cancels (no refund) the entity's pending/active seats held from any org other than `orgId`. */
export function cancelSeatsFromOtherOrgs(orgId, vendorId, runner = db) {
  return runner.none(
    `UPDATE tbl_vendor_network_seats SET status = 'cancelled', updated_at = now()
      WHERE entity_vendor_id = $2 AND org_id <> $1 AND status IN ('pending', 'active')`,
    [orgId, vendorId]
  );
}

/** Inserts a seat; null when the (entity, end_date) live-seat slot is already taken. */
export function insertSeat({ orgId, vendorId, feeAmount, startDate, endDate, status }, runner = db) {
  return runner.oneOrNone(
    `INSERT INTO tbl_vendor_network_seats (org_id, entity_vendor_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_vendor_id, end_date) WHERE status IN ('pending', 'active') DO NOTHING
     RETURNING *`,
    [orgId, vendorId, feeAmount, startDate, endDate, status]
  );
}

/**
 * Pending seats among `seatIds` that belong to `orgId` and whose entity is still live
 * there, locked FOR UPDATE (call inside a tx) so two checkouts cannot race.
 */
export function lockPayableSeats(orgId, seatIds, runner = db) {
  return runner.any(
    `SELECT s.* FROM tbl_vendor_network_seats s
       JOIN tbl_vendor_org_entities e
         ON e.org_id = s.org_id AND e.vendor_id = s.entity_vendor_id AND e.status <> 'REMOVED'
      WHERE s.org_id = $1 AND s.id = ANY($2::int[]) AND s.status = 'pending'
      ORDER BY s.id
      FOR UPDATE OF s`,
    [orgId, seatIds]
  );
}

/**
 * Ids among `seatIds` already covered by an open checkout: a 'created' network_seat
 * payment of `orgId` younger than `openMinutes` whose metadata lists the seat.
 */
export async function listSeatIdsInOpenPayment(orgId, seatIds, openMinutes, runner = db) {
  const rows = await runner.any(
    `SELECT DISTINCT (sid.value)::int AS seat_id
       FROM tbl_vendor_payments p
       CROSS JOIN LATERAL jsonb_array_elements_text(p.metadata->'seat_ids') AS sid(value)
      WHERE p.payment_type = 'network_seat' AND p.payment_status = 'created'
        AND (p.metadata->>'org_id')::int = $1
        AND p.created_at > now() - make_interval(mins => $3)
        AND (sid.value)::int = ANY($2::int[])
      ORDER BY 1`,
    [orgId, seatIds, openMinutes]
  );
  return rows.map((r) => r.seat_id);
}

export function createSeatPayment({ vendorId, orderId, amountPaise, receipt, beforeResponse, metadata }, runner = db) {
  return runner.one(
    `INSERT INTO tbl_vendor_payments
       (vendor_id, razorpay_order_id, amount, currency, payment_status, payment_type, receipt,
        before_payment_response, metadata)
     VALUES ($1, $2, $3, 'INR', 'created', 'network_seat', $4, $5, $6::jsonb)
     RETURNING *`,
    [vendorId, orderId, amountPaise, receipt, beforeResponse, JSON.stringify(metadata)]
  );
}

/** A network_seat payment by its Razorpay order id; FOR UPDATE inside a tx. */
export function getSeatPaymentByOrderId(orderId, runner = db, { forUpdate = false } = {}) {
  return runner.oneOrNone(
    `SELECT * FROM tbl_vendor_payments
      WHERE razorpay_order_id = $1 AND payment_type = 'network_seat'
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [orderId]
  );
}

/** Payment -> 'paid', recording the Razorpay payment id/signature when given. */
export function markSeatPaymentPaid(paymentId, { razorpayPaymentId = null, razorpaySignature = null } = {}, runner = db) {
  return runner.none(
    `UPDATE tbl_vendor_payments
        SET payment_status = 'paid',
            razorpay_payment_id = COALESCE($2, razorpay_payment_id),
            razorpay_signature = COALESCE($3, razorpay_signature)
      WHERE id = $1`,
    [paymentId, razorpayPaymentId, razorpaySignature]
  );
}

/** Flips the given pending seats of `orgId` to active for a paid payment; returns them. */
export function activatePendingSeats({ orgId, seatIds, paymentId, startDate, endDate }, runner = db) {
  return runner.any(
    `UPDATE tbl_vendor_network_seats
        SET status = 'active', payment_id = $3, start_date = $4, end_date = $5, updated_at = now()
      WHERE org_id = $1 AND id = ANY($2::int[]) AND status = 'pending'
      RETURNING *`,
    [orgId, seatIds, paymentId, startDate, endDate]
  );
}

// ---------------------------------------------------------------------------
// People: type-11 persons and their memberships (Task 5, spec §5 "People").
// ---------------------------------------------------------------------------

/** The tbl_users row holding `email` (case-insensitive; lowest id when duplicated), or null. */
export function findUserByEmail(email, runner = db) {
  return runner.oneOrNone(
    `SELECT id, user_type, status, COALESCE(is_deleted, 0) AS is_deleted, name, email
       FROM tbl_users WHERE lower(email) = lower($1)
      ORDER BY id LIMIT 1`,
    [email]
  );
}

/** Distinct org ids in which the person holds any membership row (any status). */
export async function listPersonOrgIds(personId, runner = db) {
  const rows = await runner.any(
    `SELECT DISTINCT org_id FROM tbl_vendor_org_members WHERE person_user_id = $1 ORDER BY 1`,
    [personId]
  );
  return rows.map((r) => r.org_id);
}

/** Distinct persons with a non-DISABLED membership in the org, `excludePersonId` aside. */
export async function countLivePersons(orgId, excludePersonId = null, runner = db) {
  const row = await runner.one(
    `SELECT count(DISTINCT person_user_id)::int AS n FROM tbl_vendor_org_members
      WHERE org_id = $1 AND status <> 'DISABLED' AND person_user_id IS DISTINCT FROM $2`,
    [orgId, excludePersonId]
  );
  return row.n;
}

/** True when the person holds a non-DISABLED membership in the org other than `exceptMembershipId`. */
export async function hasLiveMembership(orgId, personId, exceptMembershipId = null, runner = db) {
  return !!(await runner.oneOrNone(
    `SELECT 1 FROM tbl_vendor_org_members
      WHERE org_id = $1 AND person_user_id = $2 AND status <> 'DISABLED' AND id IS DISTINCT FROM $3
      LIMIT 1`,
    [orgId, personId, exceptMembershipId]
  ));
}

/** True when the person has an INVITED membership in the org whose token is still unexpired. */
export async function hasOpenMemberInvite(orgId, personId, runner = db) {
  return !!(await runner.oneOrNone(
    `SELECT 1 FROM tbl_vendor_org_members
      WHERE org_id = $1 AND person_user_id = $2 AND status = 'INVITED'
        AND invite_token_hash IS NOT NULL AND invite_expires_at > now()
      LIMIT 1`,
    [orgId, personId]
  ));
}

/** ACTIVE ORG_ADMIN memberships of the org, `excludeMembershipId` aside. */
export async function countActiveOrgAdmins(orgId, excludeMembershipId = null, runner = db) {
  const row = await runner.one(
    `SELECT count(*)::int AS n FROM tbl_vendor_org_members
      WHERE org_id = $1 AND role = 'ORG_ADMIN' AND status = 'ACTIVE' AND id IS DISTINCT FROM $2`,
    [orgId, excludeMembershipId]
  );
  return row.n;
}

/** A new person login: type 11, status 0 (INVITED), no password, no company. */
export function insertPerson({ email, name, createdBy }, runner = db) {
  return runner.one(
    `INSERT INTO tbl_users (name, email, user_type, status, company_id, password, created_by)
     VALUES ($1, $2, ${VENDOR_MEMBER_USER_TYPE}, 0, NULL, NULL, $3) RETURNING id`,
    [name, email, createdBy]
  );
}

const MEMBER_COLUMNS = `id, org_id, person_user_id, entity_vendor_id, role, status, invite_expires_at,
                        invited_by, created_at, updated_at`;

/** Inserts a membership; a `tokenHash` also stamps invite_expires_at = now() + `ttlHours`. */
export function insertMembership(
  { orgId, personId, entityVendorId, role, status, tokenHash = null, ttlHours = 0, invitedBy },
  runner = db
) {
  return runner.one(
    `INSERT INTO tbl_vendor_org_members
       (org_id, person_user_id, entity_vendor_id, role, status, invite_token_hash, invite_expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() + make_interval(hours => $7) END, $8)
     RETURNING ${MEMBER_COLUMNS}`,
    [orgId, personId, entityVendorId, role, status, tokenHash, ttlHours, invitedBy]
  );
}

/** A membership of the org with its person's login state; FOR UPDATE inside a tx. */
export function getMembership(orgId, membershipId, runner = db, { forUpdate = false } = {}) {
  return runner.oneOrNone(
    `SELECT m.id, m.org_id, m.person_user_id, m.entity_vendor_id, m.role, m.status, m.invite_expires_at,
            u.email, u.name, u.status AS user_status
       FROM tbl_vendor_org_members m
       JOIN tbl_users u ON u.id = m.person_user_id
      WHERE m.org_id = $1 AND m.id = $2
      ${forUpdate ? "FOR UPDATE OF m" : ""}`,
    [orgId, membershipId]
  );
}

/** Sets status / role / entity of a membership; clears its invite token when it leaves INVITED. */
export function updateMembership(membershipId, { status, role, entityVendorId }, runner = db) {
  return runner.one(
    `UPDATE tbl_vendor_org_members
        SET status = $2, role = $3, entity_vendor_id = $4,
            invite_token_hash = CASE WHEN $2 = 'INVITED' THEN invite_token_hash END,
            invite_expires_at = CASE WHEN $2 = 'INVITED' THEN invite_expires_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${MEMBER_COLUMNS}`,
    [membershipId, status, role, entityVendorId]
  );
}

/** Gives an INVITED membership a fresh token hash and expiry; null when it is not INVITED. */
export function rotateMemberInvite(membershipId, tokenHash, ttlHours, runner = db) {
  return runner.oneOrNone(
    `UPDATE tbl_vendor_org_members
        SET invite_token_hash = $2, invite_expires_at = now() + make_interval(hours => $3), updated_at = now()
      WHERE id = $1 AND status = 'INVITED'
      RETURNING ${MEMBER_COLUMNS}`,
    [membershipId, tokenHash, ttlHours]
  );
}

/**
 * The membership holding invite token `tokenHash`, with what the accept page may show
 * (person email, org name, entity name) and `expired`; FOR UPDATE inside a tx.
 */
export function getMemberInviteByTokenHash(tokenHash, runner = db, { forUpdate = false } = {}) {
  return runner.oneOrNone(
    `SELECT m.id, m.org_id, m.person_user_id, m.status, m.invite_expires_at <= now() AS expired,
            u.email, u.user_type, COALESCE(u.is_deleted, 0) AS is_deleted,
            o.name AS org_name, eu.name AS entity_name
       FROM tbl_vendor_org_members m
       JOIN tbl_users u ON u.id = m.person_user_id
       JOIN tbl_vendor_orgs o ON o.id = m.org_id
       LEFT JOIN tbl_users eu ON eu.id = m.entity_vendor_id
      WHERE m.invite_token_hash = $1
      ${forUpdate ? "FOR UPDATE OF m" : ""}`,
    [tokenHash]
  );
}

/**
 * Accept: a still-INVITED (status 0) person gets its password and status 1, and every
 * INVITED membership in the org turns ACTIVE. False (nothing written) for any other status.
 */
export async function activatePerson({ orgId, personId, passwordHash }, runner = db) {
  const person = await runner.result(
    `UPDATE tbl_users SET password = $2, status = 1, updated_at = now() WHERE id = $1 AND status = 0`,
    [personId, passwordHash]
  );
  if (person.rowCount !== 1) return false;
  await runner.none(
    `UPDATE tbl_vendor_org_members
        SET status = 'ACTIVE', invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
      WHERE org_id = $1 AND person_user_id = $2 AND status = 'INVITED'`,
    [orgId, personId]
  );
  return true;
}

export default {
  findUserByEmail,
  listPersonOrgIds,
  countLivePersons,
  hasLiveMembership,
  hasOpenMemberInvite,
  countActiveOrgAdmins,
  insertPerson,
  insertMembership,
  getMembership,
  updateMembership,
  rotateMemberInvite,
  getMemberInviteByTokenHash,
  activatePerson,
  getOrgByEntity,
  getOrgById,
  getEntity,
  listEntities,
  getActiveMemberships,
  getActiveSeat,
  listActableForPerson,
  getActingEntityRow,
  listActiveSiblingIds,
  mapToPrincipalIds,
  getOperateState,
  getNetworkSubscriptionStanding,
  listPushDelegates,
  isNetworkManagedLogin,
  createOrgWithPrincipal,
  updateOrgSettings,
  listEntitiesWithSeats,
  countLiveEntities,
  listMembers,
  getVendorPan,
  listVendorsByPan,
  findActiveVendor,
  isPrincipalOfAnyOrg,
  createLinkInvite,
  getLinkInvite,
  setLinkInviteStatus,
  listIncomingLinkInvites,
  listOutgoingLinkInvites,
  insertActiveEntity,
  findActiveVendorByGstin,
  emailExists,
  checkStateCity,
  insertVendorAccount,
  updateEntity,
  listPersonsOnlyViaEntity,
  removeEntity,
  getLiveSeat,
  cancelSeatsFromOtherOrgs,
  insertSeat,
  lockPayableSeats,
  listSeatIdsInOpenPayment,
  createSeatPayment,
  getSeatPaymentByOrderId,
  markSeatPaymentPaid,
  activatePendingSeats,
};
