// Vendor Networks routing sweep (spec §6.2), run every 15 minutes by cronManager:
//   1. PENDING rows past due_at → TIMED_OUT (principal notified)
//   2. self-healing: live rows whose assignee is no longer an ACTIVE entity of the org
//      (removed, suspended, left: the post-commit revoke in the entity endpoints is
//      best-effort) → REVOKED
//   3. AUTO_SINGLE_MATCH orgs: every unrouted subject with exactly one full-coverage
//      candidate is assigned to it (auto_routed), unless that candidate already
//      declined, timed out or was withdrawn from that subject.
//
// One sweep at a time across all app instances: a session advisory lock taken with
// pg_try_advisory_lock; a tick that cannot take it returns { skipped: true }. Each
// transition is its own engine transaction under the subject lock, so the sweep is safe
// next to HTTP transitions and idempotent (a raced row is simply skipped).

import db from "../../config/dbConn.js";
import { logger } from "../../util/logger.js";
import { ROUTING_MODE, ASSIGNMENT_STATUS } from "../../constants/vendorNetwork.js";
import { resolveCoverageCandidates } from "./coverage.js";
import {
  assign,
  timeOut,
  revokeOrphaned,
  registeredSubjects,
  priorRefusals,
  subjectKey,
} from "./routingEngine.js";

export const SWEEP_LOCK_KEY = "vendor_routing_sweep";
const BATCH_LIMIT = 500;

async function timeOutOverdue(now) {
  const rows = await db.any(
    `SELECT id FROM tbl_vendor_routing_assignments
      WHERE status = 'PENDING' AND due_at <= $1
      ORDER BY due_at, id
      LIMIT $2`,
    [now, BATCH_LIMIT]
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      if (await timeOut(id, now)) count += 1;
    } catch (err) {
      logger.error({ err: err.message, assignmentId: id }, "[Vendor Routing Sweep] time-out failed");
    }
  }
  return count;
}

async function revokeOrphans() {
  const rows = await db.any(
    `SELECT a.id FROM tbl_vendor_routing_assignments a
      WHERE a.status IN ('PENDING', 'ACCEPTED')
        AND NOT EXISTS (
              SELECT 1 FROM tbl_vendor_org_entities e
               WHERE e.org_id = a.org_id AND e.vendor_id = a.assigned_vendor_id AND e.status = 'ACTIVE')
      ORDER BY a.id
      LIMIT $1`,
    [BATCH_LIMIT]
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      await revokeOrphaned(id);
      count += 1;
    } catch (err) {
      logger.error({ err: err.message, assignmentId: id }, "[Vendor Routing Sweep] orphan revoke failed");
    }
  }
  return count;
}

async function autoRouteOrg(orgId) {
  // A candidate who refused or was withdrawn from a subject is never auto-routed it again.
  const refused = await priorRefusals(orgId, [
    ASSIGNMENT_STATUS.DECLINED,
    ASSIGNMENT_STATUS.TIMED_OUT,
    ASSIGNMENT_STATUS.REVOKED,
  ]);
  let count = 0;
  for (const [subjectType, handler] of registeredSubjects()) {
    if (!handler.listUnrouted) continue;
    let items;
    try {
      items = await handler.listUnrouted(orgId, db);
    } catch (err) {
      logger.error({ err: err.message, orgId, subjectType }, "[Vendor Routing Sweep] listUnrouted failed");
      continue;
    }
    for (const item of items ?? []) {
      try {
        const candidates = await resolveCoverageCandidates({
          orgId,
          hotelIds: item.hotelIds,
          categoryId: item.categoryId ?? null,
        });
        const full = candidates.filter((c) => c.covers_all_hotels);
        if (full.length !== 1) continue;
        const vendorId = Number(full[0].entity_vendor_id);
        if (refused.get(subjectKey(subjectType, item.subjectId, item.hotelId))?.has(vendorId)) continue;
        const row = await assign({
          orgId,
          subjectType,
          subjectId: item.subjectId,
          hotelId: item.hotelId ?? null,
          assigneeVendorId: vendorId,
          actorUserId: null,
          autoRouted: true,
          ifUnrouted: true,
        });
        if (row) count += 1;
      } catch (err) {
        // Refusals (subject closed meanwhile, entity raced to suspended) are expected here.
        logger.warn(
          { err: err.message, orgId, subjectType, subjectId: item.subjectId, hotelId: item.hotelId },
          "[Vendor Routing Sweep] auto-route skipped"
        );
      }
    }
  }
  return count;
}

async function autoRoute() {
  const orgs = await db.any(`SELECT id FROM tbl_vendor_orgs WHERE routing_mode = $1 ORDER BY id`, [
    ROUTING_MODE.AUTO_SINGLE_MATCH,
  ]);
  let count = 0;
  for (const { id } of orgs) {
    try {
      count += await autoRouteOrg(id);
    } catch (err) {
      logger.error({ err: err.message, orgId: id }, "[Vendor Routing Sweep] auto-route failed");
    }
  }
  return count;
}

/**
 * One sweep. Returns { skipped: true } when another sweep holds the lock, else
 * { skipped: false, timedOut, revoked, autoRouted }.
 */
export async function runRoutingSweep(now = new Date()) {
  return db.task(async (c) => {
    const { locked } = await c.one(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [SWEEP_LOCK_KEY]);
    if (!locked) return { skipped: true };
    try {
      const timedOut = await timeOutOverdue(now);
      const revoked = await revokeOrphans();
      const autoRouted = await autoRoute();
      return { skipped: false, timedOut, revoked, autoRouted };
    } finally {
      await c.one(`SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`, [SWEEP_LOCK_KEY]);
    }
  });
}

export default { runRoutingSweep, SWEEP_LOCK_KEY };
