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
// pg_try_advisory_lock (two-key form, its own namespace; see vendorRoutingModel); a tick
// that cannot take it returns { skipped: true }. Everything is per org: auto-routing asks
// each handler for one org's unrouted subjects and only ever adds that org's rows. Each
// transition is its own engine transaction under the subject lock, so the sweep is safe
// next to HTTP transitions and idempotent (a raced row is simply skipped).

import db from "../../config/dbConn.js";
import { logger } from "../../util/logger.js";
import { ROUTING_MODE, ASSIGNMENT_STATUS } from "../../constants/vendorNetwork.js";
import { resolveCoverageCandidates } from "./coverage.js";
import {
  listOverduePendingIds,
  listOrphanedLiveIds,
  listOrgIdsByRoutingMode,
  tryLockSweep,
  unlockSweep,
} from "../../models/vendorRoutingModel.js";
import {
  assign,
  timeOut,
  revokeOrphaned,
  registeredSubjects,
  priorRefusals,
  subjectKey,
} from "./routingEngine.js";

const BATCH_LIMIT = 500;

async function timeOutOverdue(now) {
  let count = 0;
  for (const id of await listOverduePendingIds(now, BATCH_LIMIT)) {
    try {
      if (await timeOut(id, now)) count += 1;
    } catch (err) {
      logger.error({ err: err.message, assignmentId: id }, "[Vendor Routing Sweep] time-out failed");
    }
  }
  return count;
}

async function revokeOrphans() {
  let count = 0;
  for (const id of await listOrphanedLiveIds(BATCH_LIMIT)) {
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
  let count = 0;
  for (const id of await listOrgIdsByRoutingMode(ROUTING_MODE.AUTO_SINGLE_MATCH)) {
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
    if (!(await tryLockSweep(c))) return { skipped: true };
    try {
      const timedOut = await timeOutOverdue(now);
      const revoked = await revokeOrphans();
      const autoRouted = await autoRoute();
      return { skipped: false, timedOut, revoked, autoRouted };
    } finally {
      await unlockSweep(c);
    }
  });
}

export default { runRoutingSweep };
