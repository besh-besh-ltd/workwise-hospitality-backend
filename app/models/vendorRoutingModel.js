// Vendor Networks routing assignments (spec §3 tbl_vendor_routing_assignments, §6.2).
// Every function takes `runner` (db or a tx). A routing subject is always keyed by
// (org_id, subject_type, subject_id, hotel_id): several orgs may route the same RFQ, and
// each org's rows are its own (the partial unique indexes include org_id too).

import db from "../config/dbConn.js";

/**
 * Advisory-lock namespaces (first key of the two-int4 form, a keyspace distinct from every
 * single-bigint advisory lock in the app). Subjects and the sweep never share a namespace.
 */
export const ROUTING_SUBJECT_LOCK_NS = 950601;
export const ROUTING_SWEEP_LOCK_NS = 950602;
export const ROUTING_SWEEP_LOCK_KEY = "vendor_routing_sweep";
/**
 * One org's quoting on one RFQ (key `<orgId>:<rfqId>`), taken by the RFQ subject's
 * quote gate and hooks (app/services/vendorNetwork/subjects/rfqSubject.js).
 */
export const RFQ_ORG_QUOTE_LOCK_NS = 950603;

/** The routing unique indexes: a 23505 on one of these is a routing race (409). */
export const ROUTING_UNIQUE_INDEXES = Object.freeze(["ix_vn_assign_org_one_pending", "ix_vn_assign_org_one_accepted"]);

const LIVE = ["PENDING", "ACCEPTED"];

/** Serialises every transition on one org's subject+hotel until transaction `t` ends. */
export function lockRoutingSubject(t, { orgId, subjectType, subjectId, hotelId }) {
  return t.one(`SELECT pg_advisory_xact_lock($1::int, hashtext($2)) AS locked`, [
    ROUTING_SUBJECT_LOCK_NS,
    `${orgId}:${subjectType}:${subjectId}:${hotelId ?? 0}`,
  ]);
}

/** The org's live (PENDING/ACCEPTED) rows of one subject+hotel, locked FOR UPDATE. */
export function lockLiveRowsForSubject(t, { orgId, subjectType, subjectId, hotelId }) {
  return t.any(
    `SELECT * FROM tbl_vendor_routing_assignments
      WHERE org_id = $1 AND subject_type = $2 AND subject_id = $3
        AND COALESCE(hotel_id, 0) = COALESCE($4::int, 0)
        AND status IN ('PENDING', 'ACCEPTED')
      ORDER BY id
      FOR UPDATE`,
    [orgId, subjectType, subjectId, hotelId ?? null]
  );
}

export function getAssignment(id, runner = db, { forUpdate = false } = {}) {
  return runner.oneOrNone(
    `SELECT * FROM tbl_vendor_routing_assignments WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [id]
  );
}

/** The live (non-REMOVED) entity row of `vendorId` in `orgId`, FOR SHARE. */
export function getOrgEntityForShare(orgId, vendorId, t) {
  return t.oneOrNone(
    `SELECT * FROM tbl_vendor_org_entities
      WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'
      FOR SHARE`,
    [orgId, vendorId]
  );
}

/** Moves a row to a terminal status (decline fields kept unless given). */
export function releaseAssignment(t, id, { status, actorUserId = null, declineReason = null, declineNote = null }) {
  return t.one(
    `UPDATE tbl_vendor_routing_assignments
        SET status = $2, acted_by_user_id = $3, acted_at = now(),
            decline_reason = COALESCE($4, decline_reason), decline_note = COALESCE($5, decline_note)
      WHERE id = $1
      RETURNING *`,
    [id, status, actorUserId, declineReason, declineNote]
  );
}

export function acceptAssignment(t, id, actorUserId = null) {
  return t.one(
    `UPDATE tbl_vendor_routing_assignments
        SET status = 'ACCEPTED', acted_by_user_id = $2, acted_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, actorUserId]
  );
}

export function insertPendingAssignment(
  t,
  { orgId, subjectType, subjectId, hotelId, assigneeVendorId, dueAt, autoRouted, assignedByUserId }
) {
  return t.one(
    `INSERT INTO tbl_vendor_routing_assignments
       (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status, due_at, auto_routed, assigned_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)
     RETURNING *`,
    [orgId, subjectType, subjectId, hotelId ?? null, assigneeVendorId, dueAt, autoRouted === true, assignedByUserId ?? null]
  );
}

/** The entity's own email plus its ACTIVE ENTITY_MEMBER persons' emails in `orgId` (raw, may repeat). */
export async function listAssigneeEmails(orgId, vendorId, runner = db) {
  const rows = await runner.any(
    `SELECT u.email FROM tbl_users u WHERE u.id = $2
     UNION
     SELECT p.email
       FROM tbl_vendor_org_members m
       JOIN tbl_users p ON p.id = m.person_user_id AND p.status = 1 AND COALESCE(p.is_deleted, 0) = 0
      WHERE m.org_id = $1 AND m.entity_vendor_id = $2 AND m.status = 'ACTIVE' AND m.role = 'ENTITY_MEMBER'`,
    [orgId, vendorId]
  );
  return rows.map((r) => r.email);
}

export async function getUserDisplayName(userId, runner = db) {
  if (!userId) return null;
  const row = await runner.oneOrNone(
    `SELECT COALESCE(NULLIF(TRIM(name), ''), email) AS name FROM tbl_users WHERE id = $1`,
    [userId]
  );
  return row?.name ?? null;
}

/** Ids of the live rows held by `vendorId`, in `orgId` when given (else in any org). */
export async function listLiveAssignmentIdsForEntity(vendorId, orgId = null, runner = db) {
  const rows = await runner.any(
    `SELECT id FROM tbl_vendor_routing_assignments
      WHERE assigned_vendor_id = $1 AND status IN ('PENDING', 'ACCEPTED')
        AND ($2::int IS NULL OR org_id = $2)
      ORDER BY id`,
    [vendorId, orgId]
  );
  return rows.map((r) => r.id);
}

/** PENDING rows whose due_at has passed by `now`. */
export async function listOverduePendingIds(now, limit, runner = db) {
  const rows = await runner.any(
    `SELECT id FROM tbl_vendor_routing_assignments
      WHERE status = 'PENDING' AND due_at <= $1
      ORDER BY due_at, id
      LIMIT $2`,
    [now, limit]
  );
  return rows.map((r) => r.id);
}

/** Live rows whose assignee has no ACTIVE entity row in the row's org. */
export async function listOrphanedLiveIds(limit, runner = db) {
  const rows = await runner.any(
    `SELECT a.id FROM tbl_vendor_routing_assignments a
      WHERE a.status IN ('PENDING', 'ACCEPTED')
        AND NOT EXISTS (
              SELECT 1 FROM tbl_vendor_org_entities e
               WHERE e.org_id = a.org_id AND e.vendor_id = a.assigned_vendor_id AND e.status = 'ACTIVE')
      ORDER BY a.id
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

export async function listOrgIdsByRoutingMode(routingMode, runner = db) {
  const rows = await runner.any(`SELECT id FROM tbl_vendor_orgs WHERE routing_mode = $1 ORDER BY id`, [routingMode]);
  return rows.map((r) => r.id);
}

/**
 * (subject_type, subject_id, hotel_key, assigned_vendor_id, status) of the org's rows in
 * `statuses`: one row per subject and assignee, carrying the status of its latest row.
 */
export function listOrgAssigneesByStatus(orgId, statuses, runner = db) {
  return runner.any(
    `SELECT DISTINCT ON (subject_type, subject_id, COALESCE(hotel_id, 0), assigned_vendor_id)
            subject_type, subject_id, COALESCE(hotel_id, 0) AS hotel_key, assigned_vendor_id, status
       FROM tbl_vendor_routing_assignments
      WHERE org_id = $1 AND status = ANY($2::text[])
      ORDER BY subject_type, subject_id, COALESCE(hotel_id, 0), assigned_vendor_id,
               COALESCE(acted_at, created_at) DESC, id DESC`,
    [orgId, statuses]
  );
}

/** An org's assignments with assignee name, newest first (max 500). */
export function listOrgAssignments(orgId, { statuses = null, subjectType = null, actedSince = null } = {}, runner = db) {
  return runner.any(
    `SELECT a.*, u.name AS assignee_name, ent.relationship AS assignee_relationship,
            ent.status AS assignee_entity_status
       FROM tbl_vendor_routing_assignments a
       JOIN tbl_users u ON u.id = a.assigned_vendor_id
       LEFT JOIN tbl_vendor_org_entities ent ON ent.vendor_id = a.assigned_vendor_id AND ent.org_id = a.org_id
                                            AND ent.status <> 'REMOVED'
      WHERE a.org_id = $1
        AND ($2::text[] IS NULL OR a.status = ANY($2::text[]))
        AND ($3::text IS NULL OR a.subject_type = $3)
        AND ($4::timestamptz IS NULL OR COALESCE(a.acted_at, a.created_at) >= $4)
      ORDER BY a.id DESC
      LIMIT 500`,
    [orgId, statuses, subjectType, actedSince]
  );
}

/** Assignments addressed to an entity in an org it is still live in, newest first (max 500). */
export function listAssigneeAssignments(vendorId, statuses = LIVE, runner = db) {
  return runner.any(
    `SELECT a.*
       FROM tbl_vendor_routing_assignments a
       JOIN tbl_vendor_org_entities ent
         ON ent.vendor_id = a.assigned_vendor_id AND ent.org_id = a.org_id AND ent.status <> 'REMOVED'
      WHERE a.assigned_vendor_id = $1 AND a.status = ANY($2::text[])
      ORDER BY a.id DESC
      LIMIT 500`,
    [vendorId, statuses]
  );
}

/** Session-level sweep lock on connection `c`: true when taken. */
export async function tryLockSweep(c) {
  const { locked } = await c.one(`SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked`, [
    ROUTING_SWEEP_LOCK_NS,
    ROUTING_SWEEP_LOCK_KEY,
  ]);
  return locked;
}

export function unlockSweep(c) {
  return c.one(`SELECT pg_advisory_unlock($1::int, hashtext($2)) AS unlocked`, [
    ROUTING_SWEEP_LOCK_NS,
    ROUTING_SWEEP_LOCK_KEY,
  ]);
}

export default {
  ROUTING_SUBJECT_LOCK_NS,
  ROUTING_SWEEP_LOCK_NS,
  ROUTING_SWEEP_LOCK_KEY,
  RFQ_ORG_QUOTE_LOCK_NS,
  ROUTING_UNIQUE_INDEXES,
  lockRoutingSubject,
  lockLiveRowsForSubject,
  getAssignment,
  getOrgEntityForShare,
  releaseAssignment,
  acceptAssignment,
  insertPendingAssignment,
  listAssigneeEmails,
  getUserDisplayName,
  listLiveAssignmentIdsForEntity,
  listOverduePendingIds,
  listOrphanedLiveIds,
  listOrgIdsByRoutingMode,
  listOrgAssigneesByStatus,
  listOrgAssignments,
  listAssigneeAssignments,
  tryLockSweep,
  unlockSweep,
};
