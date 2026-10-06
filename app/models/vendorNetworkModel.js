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
      WHERE e.vendor_id = ANY($1::int[]) AND e.status = 'ACTIVE'
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
};
