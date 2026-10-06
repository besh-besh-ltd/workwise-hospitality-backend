// Vendor Networks reads (spec 2026-10-06-vendor-networks-design.md, §3-§5).
// Every function takes `runner` (db or a tx) last. "Live" entity = status <> 'REMOVED';
// the partial unique index ix_vn_entities_live_vendor makes vendor_id lookups exact.

import db from "../config/dbConn.js";

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

/** The current active seat of an entity in its live org (end_date >= today), or null. */
export function getActiveSeat(entityId, runner = db) {
  return runner.oneOrNone(
    `SELECT s.*
       FROM tbl_vendor_network_seats s
       JOIN tbl_vendor_org_entities e
         ON e.vendor_id = s.entity_vendor_id AND e.org_id = s.org_id AND e.status <> 'REMOVED'
      WHERE s.entity_vendor_id = $1 AND s.status = 'active' AND s.end_date >= CURRENT_DATE
      ORDER BY s.end_date DESC
      LIMIT 1`,
    [entityId]
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
  const rows = await runner.any(
    `SELECT e2.vendor_id
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_org_entities e2 ON e2.org_id = e.org_id AND e2.status = 'ACTIVE'
       JOIN tbl_users u2 ON u2.id = e2.vendor_id AND u2.status = 1 AND COALESCE(u2.is_deleted, 0) = 0
      WHERE e.vendor_id = $1 AND e.status = 'ACTIVE'
      ORDER BY e2.vendor_id`,
    [vendorId]
  );
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

/** Entity placement plus a has-current-seat flag, in one query; null for a vendor in no org. */
export function getOperateState(vendorId, runner = db) {
  return runner.oneOrNone(
    `SELECT e.org_id, e.relationship, e.status AS entity_status, o.principal_vendor_id,
            EXISTS (
              SELECT 1 FROM tbl_vendor_network_seats s
               WHERE s.entity_vendor_id = e.vendor_id AND s.org_id = e.org_id
                 AND s.status = 'active' AND s.end_date >= CURRENT_DATE
            ) AS has_seat
       FROM tbl_vendor_org_entities e
       JOIN tbl_vendor_orgs o ON o.id = e.org_id
      WHERE e.vendor_id = $1 AND e.status <> 'REMOVED'`,
    [vendorId]
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

/** Live entities with their login and current seat (active wins over pending), principal first. */
export function listEntitiesWithSeats(orgId, runner = db) {
  return runner.any(
    `SELECT e.vendor_id, e.relationship, e.status, e.preference_rank, e.linked_at,
            u.name, u.email, u.status AS user_status,
            s.id AS seat_id, s.status AS seat_status, s.end_date AS seat_end_date, s.fee_amount AS seat_fee_amount
       FROM tbl_vendor_org_entities e
       JOIN tbl_users u ON u.id = e.vendor_id
       LEFT JOIN LATERAL (
         SELECT id, status, end_date, fee_amount FROM tbl_vendor_network_seats
          WHERE org_id = e.org_id AND entity_vendor_id = e.vendor_id
            AND status IN ('active', 'pending') AND end_date >= CURRENT_DATE
          ORDER BY (status = 'active') DESC, end_date DESC
          LIMIT 1
       ) s ON true
      WHERE e.org_id = $1 AND e.status <> 'REMOVED'
      ORDER BY (e.relationship = 'PRINCIPAL') DESC, e.vendor_id`,
    [orgId]
  );
}

/** Non-disabled memberships of an org with each person's name and email. */
export function listMembers(orgId, runner = db) {
  return runner.any(
    `SELECT m.id, m.person_user_id, m.entity_vendor_id, m.role, m.status, m.invite_expires_at,
            u.name, u.email
       FROM tbl_vendor_org_members m
       JOIN tbl_users u ON u.id = m.person_user_id
      WHERE m.org_id = $1 AND m.status <> 'DISABLED'
      ORDER BY m.role, m.id`,
    [orgId]
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

export function createLinkInvite({ orgId, targetVendorId, relationship, tokenHash, ttlDays, createdBy }, runner = db) {
  return runner.one(
    `INSERT INTO tbl_vendor_org_link_invites
       (org_id, target_vendor_id, relationship, token_hash, status, expires_at, created_by)
     VALUES ($1, $2, $3, $4, 'PENDING', now() + make_interval(days => $5), $6)
     RETURNING id, org_id, target_vendor_id, relationship, status, expires_at, created_at`,
    [orgId, targetVendorId, relationship, tokenHash, ttlDays, createdBy]
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

export function setLinkInviteStatus(inviteId, status, runner = db) {
  return runner.none(
    `UPDATE tbl_vendor_org_link_invites SET status = $2, acted_at = now() WHERE id = $1`,
    [inviteId, status]
  );
}

/** PENDING, unexpired invites addressed to a vendor, newest first. */
export function listIncomingLinkInvites(targetVendorId, runner = db) {
  return runner.any(
    `SELECT i.id, i.org_id, o.name AS org_name, i.relationship, i.status, i.expires_at, i.created_at
       FROM tbl_vendor_org_link_invites i
       JOIN tbl_vendor_orgs o ON o.id = i.org_id
      WHERE i.target_vendor_id = $1 AND i.status = 'PENDING' AND i.expires_at > now()
      ORDER BY i.created_at DESC, i.id DESC`,
    [targetVendorId]
  );
}

/** PENDING, unexpired invites an org has sent, newest first. */
export function listOutgoingLinkInvites(orgId, runner = db) {
  return runner.any(
    `SELECT i.id, i.target_vendor_id, u.name AS target_name, u.email AS target_email,
            i.relationship, i.status, i.expires_at, i.created_at
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

/** tbl_company + passwordless type-3 tbl_users + tbl_company_location for a new network entity. */
export async function insertVendorAccount({ companyName, gstin, email, stateId, cityId, address, createdBy }, runner = db) {
  const company = await runner.one(
    `INSERT INTO tbl_company (company_name, gstin) VALUES ($1, $2) RETURNING id`,
    [companyName, gstin]
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

/** Sets status (and/or preference_rank) of a live entity; returns the row. */
export function updateEntity(orgId, vendorId, { status, preferenceRank }, runner = db) {
  return runner.one(
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
 * memberships DISABLED, its pending seats cancelled. Active seats stay to expiry.
 */
export async function removeEntity(orgId, vendorId, runner = db) {
  await runner.none(
    `UPDATE tbl_vendor_org_entities
        SET status = 'REMOVED', removed_at = now(), updated_at = now()
      WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'`,
    [orgId, vendorId]
  );
  await runner.none(
    `UPDATE tbl_vendor_org_members SET status = 'DISABLED', updated_at = now()
      WHERE org_id = $1 AND entity_vendor_id = $2 AND role = 'ENTITY_MEMBER' AND status <> 'DISABLED'`,
    [orgId, vendorId]
  );
  await runner.none(
    `UPDATE tbl_vendor_network_seats SET status = 'cancelled', updated_at = now()
      WHERE org_id = $1 AND entity_vendor_id = $2 AND status = 'pending'`,
    [orgId, vendorId]
  );
}

// ---------------------------------------------------------------------------
// Seats (spec §5.1).
// ---------------------------------------------------------------------------

/** The entity's current pending-or-active seat in `orgId` (active first), or null. */
export function getLiveSeat(orgId, vendorId, runner = db) {
  return runner.oneOrNone(
    `SELECT * FROM tbl_vendor_network_seats
      WHERE org_id = $1 AND entity_vendor_id = $2
        AND status IN ('active', 'pending') AND end_date >= CURRENT_DATE
      ORDER BY (status = 'active') DESC, end_date DESC
      LIMIT 1`,
    [orgId, vendorId]
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

/** Pending seats among `seatIds` that belong to `orgId` and whose entity is still live there. */
export function listPayableSeats(orgId, seatIds, runner = db) {
  return runner.any(
    `SELECT s.* FROM tbl_vendor_network_seats s
       JOIN tbl_vendor_org_entities e
         ON e.org_id = s.org_id AND e.vendor_id = s.entity_vendor_id AND e.status <> 'REMOVED'
      WHERE s.org_id = $1 AND s.id = ANY($2::int[]) AND s.status = 'pending'
      ORDER BY s.id`,
    [orgId, seatIds]
  );
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

export default {
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
  listPushDelegates,
  isNetworkManagedLogin,
  createOrgWithPrincipal,
  updateOrgSettings,
  listEntitiesWithSeats,
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
  listPayableSeats,
  createSeatPayment,
  getSeatPaymentByOrderId,
  markSeatPaymentPaid,
  activatePendingSeats,
};
