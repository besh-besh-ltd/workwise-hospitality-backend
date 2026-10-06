// Vendor Networks routing engine (spec §6.2): one assignment state machine for every
// subject type, with the subject-specific work delegated to a registered handler.
//
//   assign ─▶ PENDING ──accept──▶ ACCEPTED ──(another accepted)──▶ SUPERSEDED
//                │  ├─decline──▶ DECLINED
//                │  ├─due_at ──▶ TIMED_OUT   (routingSweep)
//                │  └─revoke ──▶ REVOKED     (admin, entity removal; ACCEPTED too)
//
// Every transition runs in one db.tx that first takes a transaction advisory lock on
// the subject key (type, id, hotel) and then SELECT … FOR UPDATE on the subject's live
// rows, so two transitions on one subject serialise even when no row exists yet. The
// partial unique indexes (one PENDING, one ACCEPTED per subject+hotel) are the backstop:
// a 23505 surfaces as 409. Notifications, emails and activity rows go out after commit
// and never fail the transition.
//
// Handler contract (registerSubject(subjectType, handler)); every hook receives the
// transaction `t` and may throw { http, message, code } to refuse, which rolls the whole
// transition back and answers with that HTTP status:
//   validateSubject({ orgId, principalVendorId, subjectId, hotelId }, t)
//       -> { ok:true, dueCap?:Date, hotelIds:number[], categoryId:number|null }
//        | { ok:false, http, message, code? }
//   onPending(assignment, t)                       the new PENDING row
//   onAccepted(assignment, previousAccepted|null, t)
//   onReleased(assignment, priorStatus, t)         assignment.status is the new one
//       (DECLINED|TIMED_OUT|REVOKED|SUPERSEDED); assignment.release_reason says why:
//       'ADMIN_REVOKED' | 'REASSIGNED' | 'DECLINED' | 'TIMED_OUT' | 'SUPERSEDED' |
//       'ENTITY_REMOVED' | 'ENTITY_SUSPENDED' | 'ENTITY_NOT_ACTIVE'. A handler must not
//       refuse an ENTITY_* release: the entity has already lost network access.
//   describe(assignment, runner) -> { title, actionUrl }     notifications/email copy
//   listUnrouted(orgId, runner)  -> [{ subjectId, hotelId|null, hotelIds, categoryId, title?, meta? }]
//   activityScope(assignment, runner) (optional)
//       -> { hospitalityCompanyId, hotelId?, entityType?, entityId?, entityLabel? } | null
//       the buyer company whose activity trail records the transition; without one the
//       activity row is not written (tbl_activity_events is company-scoped).

import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { sendMail } from "../../helper/common.js";
import { generateEmailTemplate } from "../../helper/notificationEmailLayout.js";
import { dispatch as dispatchNotification } from "../notificationService.js";
import { recordActivityEvent } from "../../models/activityModel.js";
import { CATEGORIES } from "../activity/eventRegistry.js";
import { NetworkHttpError } from "./guards.js";
import { entityCanOperate } from "./actingContext.js";
import {
  ASSIGNMENT_STATUS,
  DECLINE_REASON,
  ENTITY_RELATIONSHIP,
  ENTITY_STATUS,
  RFQ_DUE_FLOOR_HOURS_FROM_NOW,
} from "../../constants/vendorNetwork.js";

const { PENDING, ACCEPTED, DECLINED, TIMED_OUT, REVOKED, SUPERSEDED } = ASSIGNMENT_STATUS;
const LIVE = [PENDING, ACCEPTED];
const HOUR_MS = 3600 * 1000;
const UNIQUE_VIOLATION = "23505";
const MAX_DECLINE_NOTE = 1000;
const DEFAULT_FRONT_BASE_URL = "https://hospitality.letsworkwise.com";
export const ROUTING_URL = "/dashboard/vendor/network/routing";
export const ASSIGNED_URL = "/dashboard/vendor/network/assigned";

// --- subject registry -----------------------------------------------------------

const handlers = new Map();

/**
 * Registers the handler for a subject type and returns the one it replaces (tests use
 * that to restore). A null handler unregisters.
 */
export function registerSubject(subjectType, handler) {
  const previous = handlers.get(subjectType) ?? null;
  if (handler) handlers.set(subjectType, handler);
  else handlers.delete(subjectType);
  return previous;
}

export function getSubjectHandler(subjectType) {
  return handlers.get(subjectType) ?? null;
}

/** [subjectType, handler] pairs of every registered subject. */
export function registeredSubjects() {
  return [...handlers.entries()];
}

// --- errors -----------------------------------------------------------------------

/** Handler refusals ({http, message, code}) and unique-index races as NetworkHttpError. */
function asNetworkError(err) {
  if (err instanceof NetworkHttpError) return err;
  if (err && Number.isInteger(err.http)) {
    return new NetworkHttpError(err.http, err.message || "Request refused", err.code ?? err.reason);
  }
  if (err?.code === UNIQUE_VIOLATION) {
    return new NetworkHttpError(409, "This item was routed by someone else at the same time; reload and retry", "CONFLICT");
  }
  return err;
}

/** db.tx whose errors come out as NetworkHttpError when they are business refusals. */
async function transition(fn) {
  try {
    return await db.tx(fn);
  } catch (err) {
    throw asNetworkError(err);
  }
}

// --- locking and reads ------------------------------------------------------------

/** Serialises every transition on one subject+hotel for the rest of transaction `t`. */
function lockSubject(t, subjectType, subjectId, hotelId) {
  return t.one(`SELECT pg_advisory_xact_lock(hashtext($1)) AS locked`, [
    `vn_routing:${subjectType}:${subjectId}:${hotelId ?? 0}`,
  ]);
}

function liveRowsForUpdate(t, subjectType, subjectId, hotelId) {
  return t.any(
    `SELECT * FROM tbl_vendor_routing_assignments
      WHERE subject_type = $1 AND subject_id = $2 AND COALESCE(hotel_id, 0) = COALESCE($3::int, 0)
        AND status IN ('PENDING', 'ACCEPTED')
      ORDER BY id
      FOR UPDATE`,
    [subjectType, subjectId, hotelId ?? null]
  );
}

function getAssignment(id, runner = db) {
  return runner.oneOrNone(`SELECT * FROM tbl_vendor_routing_assignments WHERE id = $1`, [id]);
}

/**
 * Locks the subject of assignment `id` and returns the row FOR UPDATE, or null.
 * The subject lock comes first (same order as assign), then the row.
 */
async function lockAssignment(t, id) {
  const peek = await getAssignment(id, t);
  if (!peek) return null;
  await lockSubject(t, peek.subject_type, peek.subject_id, peek.hotel_id);
  return t.oneOrNone(`SELECT * FROM tbl_vendor_routing_assignments WHERE id = $1 FOR UPDATE`, [id]);
}

// --- transitions (inside a tx) ------------------------------------------------------

/** Moves a live row to a terminal status and runs the handler's onReleased. */
async function releaseRow(t, row, toStatus, { actorUserId, reason, declineReason = null, declineNote = null }) {
  const updated = await t.one(
    `UPDATE tbl_vendor_routing_assignments
        SET status = $2, acted_by_user_id = $3, acted_at = now(),
            decline_reason = COALESCE($4, decline_reason), decline_note = COALESCE($5, decline_note)
      WHERE id = $1
      RETURNING *`,
    [row.id, toStatus, actorUserId ?? null, declineReason, declineNote]
  );
  const handler = getSubjectHandler(row.subject_type);
  const released = { ...updated, release_reason: reason };
  if (handler?.onReleased) await handler.onReleased(released, row.status, t);
  return released;
}

/** Collected inside a tx, flushed after commit. */
function effect(kind, assignment, from, extra = {}) {
  return { kind, assignment, from, ...extra };
}

// --- after commit -------------------------------------------------------------------

async function safeDescribe(assignment) {
  const handler = getSubjectHandler(assignment.subject_type);
  try {
    const d = handler?.describe ? await handler.describe(assignment, db) : null;
    if (d?.title) return d;
  } catch (err) {
    logger.warn({ err: err.message, assignmentId: assignment.id }, "vendor-routing describe failed");
  }
  const what = assignment.subject_type === "ARC_HOTEL" ? "Rate contract" : "RFQ";
  return { title: `${what} #${assignment.subject_id}`, actionUrl: null };
}

async function notify({ userIds, type, title, body, actionUrl, data }) {
  try {
    await dispatchNotification({ userIds, category: "NETWORK", type, title, body, actionUrl, data });
  } catch (err) {
    logger.warn({ err: err.message, type }, "vendor-routing notification failed");
  }
}

/** The assignee entity's email plus the emails of its ACTIVE member persons, de-duplicated. */
async function assigneeEmails(vendorId) {
  const rows = await db.any(
    `SELECT u.email FROM tbl_users u WHERE u.id = $1
     UNION
     SELECT p.email
       FROM tbl_vendor_org_members m
       JOIN tbl_users p ON p.id = m.person_user_id AND p.status = 1 AND COALESCE(p.is_deleted, 0) = 0
      WHERE m.entity_vendor_id = $1 AND m.status = 'ACTIVE' AND m.role = 'ENTITY_MEMBER'`,
    [vendorId]
  );
  const seen = new Set();
  return rows
    .map((r) => (typeof r.email === "string" ? r.email.trim() : ""))
    .filter((e) => e && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function emailAssignee(assignment, described, dueAt) {
  try {
    const recipients = await assigneeEmails(assignment.assigned_vendor_id);
    if (!recipients.length) return;
    const base = (process.env.FRONT_BASE_URL || DEFAULT_FRONT_BASE_URL).replace(/\/+$/, "");
    const link = `${base}${ASSIGNED_URL}`;
    const due = dueAt ? new Date(dueAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : null;
    const html = generateEmailTemplate(
      `<h5>New assignment from your network</h5>`,
      `<div style="font-size:16px; font-family: 'Roboto', sans-serif;">
         <p>${escapeHtml(described.title)} has been routed to you.</p>
         ${due ? `<p>Please accept or decline by ${escapeHtml(due)} IST.</p>` : ""}
         <p><a href="${link}">Open your assignments</a></p>
       </div>`
    );
    const subject = `Work wise | New assignment: ${described.title}`;
    await Promise.all(
      recipients.map((to) =>
        Promise.resolve(sendMail({ to, from: Config.webmasterMail, subject, html })).catch((err) =>
          logger.warn({ err: err.message }, "vendor-routing email failed")
        )
      )
    );
  } catch (err) {
    logger.warn({ err: err.message, assignmentId: assignment.id }, "vendor-routing email failed");
  }
}

const VERBS = {
  [PENDING]: "routed",
  [ACCEPTED]: "accepted",
  [DECLINED]: "declined",
  [TIMED_OUT]: "timed out",
  [REVOKED]: "revoked",
  [SUPERSEDED]: "superseded",
};

async function nameOf(userId) {
  if (!userId) return null;
  const row = await db.oneOrNone(`SELECT COALESCE(NULLIF(TRIM(name), ''), email) AS name FROM tbl_users WHERE id = $1`, [userId]);
  return row?.name ?? null;
}

/** One tbl_activity_events row per transition, attributed to the person (SYSTEM for the sweep). */
async function recordTransitionActivity(e, described, actor) {
  try {
    const a = e.assignment;
    const handler = getSubjectHandler(a.subject_type);
    const scope = handler?.activityScope ? await handler.activityScope(a, db) : null;
    if (!scope?.hospitalityCompanyId) return;
    const assigneeName = (await nameOf(a.assigned_vendor_id)) || `Vendor #${a.assigned_vendor_id}`;
    const actorLabel = actor.userId ? actor.label || (await nameOf(actor.userId)) || `User #${actor.userId}` : "System";
    const verb = VERBS[a.status] ?? a.status.toLowerCase();
    await recordActivityEvent({
      source: actor.userId ? "HTTP" : "CRON",
      eventKey: `vendor_routing_${a.status.toLowerCase()}`,
      category: CATEGORIES.VENDORS,
      severity: "routine",
      actorType: actor.userId ? "VENDOR" : "SYSTEM",
      actorUserId: actor.userId ?? null,
      actorLabel,
      hospitalityCompanyId: scope.hospitalityCompanyId,
      hotelId: scope.hotelId ?? a.hotel_id ?? null,
      entityType: scope.entityType ?? a.subject_type,
      entityId: scope.entityId ?? a.subject_id,
      entityLabel: scope.entityLabel ?? described.title,
      summary:
        a.status === PENDING
          ? `${actorLabel} routed ${described.title} to ${assigneeName}`
          : `${described.title}: assignment to ${assigneeName} ${verb}`,
      metadata: {
        assignment_id: a.id,
        org_id: a.org_id,
        subject_type: a.subject_type,
        subject_id: a.subject_id,
        hotel_id: a.hotel_id,
        assigned_vendor_id: a.assigned_vendor_id,
        from_status: e.from,
        to_status: a.status,
        reason: a.release_reason ?? null,
        auto_routed: a.auto_routed,
      },
    });
  } catch (err) {
    logger.warn({ err: err.message }, "vendor-routing activity write failed");
  }
}

/** Runs the post-commit side effects of one transition. Never throws. */
async function flushEffects(effects, actor) {
  for (const e of effects) {
    try {
      const a = e.assignment;
      const described = await safeDescribe(a);
      const data = {
        assignment_id: a.id,
        subject_type: a.subject_type,
        subject_id: a.subject_id,
        hotel_id: a.hotel_id,
        assigned_vendor_id: a.assigned_vendor_id,
      };
      const principalId = e.principalVendorId;
      const assigneeName = (await nameOf(a.assigned_vendor_id)) || "A network entity";
      if (a.status === PENDING) {
        await notify({
          userIds: [a.assigned_vendor_id],
          type: "NETWORK_ROUTING_ASSIGNED",
          title: "New assignment",
          body: `${described.title} has been routed to you. Accept or decline it.`,
          actionUrl: described.actionUrl || ASSIGNED_URL,
          data: { ...data, due_at: a.due_at },
        });
        await emailAssignee(a, described, a.due_at);
      } else if (a.status === REVOKED) {
        await notify({
          userIds: [a.assigned_vendor_id],
          type: "NETWORK_ROUTING_REVOKED",
          title: "Assignment withdrawn",
          body: `${described.title} is no longer assigned to you.`,
          actionUrl: ASSIGNED_URL,
          data,
        });
      } else if ([ACCEPTED, DECLINED, TIMED_OUT].includes(a.status) && principalId) {
        const body =
          a.status === ACCEPTED
            ? `${assigneeName} accepted ${described.title}.`
            : a.status === DECLINED
              ? `${assigneeName} declined ${described.title} (${a.decline_reason}${a.decline_note ? `: ${a.decline_note}` : ""}). It is back in your routing queue.`
              : `${assigneeName} did not respond to ${described.title} in time. It is back in your routing queue.`;
        await notify({
          userIds: [principalId],
          type: `NETWORK_ROUTING_${a.status}`,
          title: a.status === ACCEPTED ? "Assignment accepted" : a.status === DECLINED ? "Assignment declined" : "Assignment timed out",
          body,
          actionUrl: ROUTING_URL,
          data: { ...data, decline_reason: a.decline_reason ?? null },
        });
      }
      await recordTransitionActivity(e, described, actor);
    } catch (err) {
      logger.warn({ err: err.message }, "vendor-routing post-commit effect failed");
    }
  }
}

// --- public API -----------------------------------------------------------------------

/** due_at = max(now + 1h, min(now + timeoutHours, dueCap)). */
export function computeDueAt(now, timeoutHours, dueCap = null) {
  let due = now.getTime() + Number(timeoutHours) * HOUR_MS;
  if (dueCap) due = Math.min(due, new Date(dueCap).getTime());
  return new Date(Math.max(due, now.getTime() + RFQ_DUE_FLOOR_HOURS_FROM_NOW * HOUR_MS));
}

/**
 * Routes a subject (+hotel) to a member entity: a new PENDING row. A PENDING one for the
 * same subject+hotel is REVOKED; an ACCEPTED one stays until the new one is accepted.
 * `ifUnrouted` (sweep auto-routing) makes it a no-op returning null when a live row exists.
 */
export async function assign({
  orgId,
  subjectType,
  subjectId,
  hotelId = null,
  assigneeVendorId,
  actorUserId,
  actorLabel = null,
  autoRouted = false,
  ifUnrouted = false,
}) {
  const handler = getSubjectHandler(subjectType);
  if (!handler) throw new NetworkHttpError(400, `Unknown subject type ${subjectType}`, "UNKNOWN_SUBJECT");

  const effects = [];
  const created = await transition(async (t) => {
    const org = await t.oneOrNone(`SELECT * FROM tbl_vendor_orgs WHERE id = $1`, [orgId]);
    if (!org) throw new NetworkHttpError(404, "Network not found");

    await lockSubject(t, subjectType, subjectId, hotelId);
    const live = await liveRowsForUpdate(t, subjectType, subjectId, hotelId);
    if (ifUnrouted && live.length) return null;

    // The assignee: an ACTIVE, non-principal entity of this org that may operate. FOR SHARE
    // holds off a concurrent suspend/remove until this commits (its revoke then sees the row).
    const entity = await t.oneOrNone(
      `SELECT * FROM tbl_vendor_org_entities
        WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED'
        FOR SHARE`,
      [orgId, assigneeVendorId]
    );
    const eligible =
      entity &&
      entity.status === ENTITY_STATUS.ACTIVE &&
      entity.relationship !== ENTITY_RELATIONSHIP.PRINCIPAL &&
      Number(assigneeVendorId) !== Number(org.principal_vendor_id) &&
      (await entityCanOperate(assigneeVendorId, t)).ok;
    if (!eligible) {
      throw new NetworkHttpError(409, "That entity cannot be assigned work in this network", "ASSIGNEE_NOT_ELIGIBLE");
    }

    const valid = await handler.validateSubject(
      { orgId, principalVendorId: org.principal_vendor_id, subjectId, hotelId },
      t
    );
    if (!valid?.ok) {
      throw new NetworkHttpError(valid?.http ?? 400, valid?.message ?? "This item cannot be routed", valid?.code);
    }

    const accepted = live.find((r) => r.status === ACCEPTED);
    if (accepted && Number(accepted.assigned_vendor_id) === Number(assigneeVendorId)) {
      throw new NetworkHttpError(409, "This entity has already accepted this item", "ALREADY_ACCEPTED");
    }
    const pending = live.find((r) => r.status === PENDING);
    if (pending) {
      const released = await releaseRow(t, pending, REVOKED, { actorUserId, reason: "REASSIGNED" });
      effects.push(effect("release", released, PENDING, { principalVendorId: org.principal_vendor_id }));
    }

    const dueAt = computeDueAt(new Date(), org.routing_timeout_hours, valid.dueCap ?? null);
    const row = await t.one(
      `INSERT INTO tbl_vendor_routing_assignments
         (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status, due_at, auto_routed, assigned_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)
       RETURNING *`,
      [orgId, subjectType, subjectId, hotelId ?? null, assigneeVendorId, dueAt, autoRouted === true, actorUserId ?? null]
    );
    if (handler.onPending) await handler.onPending(row, t);
    effects.push(effect("pending", row, null, { principalVendorId: org.principal_vendor_id }));
    return row;
  });
  if (created) await flushEffects(effects, { userId: actorUserId ?? null, label: actorLabel });
  return created;
}

/**
 * The assignee (any person acting as `actingVendorId`) accepts or declines a PENDING row.
 * Not the assignee → 404 (existence is not leaked). Past due_at → it times out here and 409.
 */
export async function respond({ assignmentId, actingVendorId, actorUserId, actorLabel = null, decision, reason, note }) {
  if (decision !== "ACCEPT" && decision !== "DECLINE") {
    throw new NetworkHttpError(400, "decision must be ACCEPT or DECLINE");
  }
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (decision === "DECLINE") {
    if (!Object.values(DECLINE_REASON).includes(reason)) {
      throw new NetworkHttpError(400, `reason must be one of ${Object.values(DECLINE_REASON).join(", ")}`);
    }
    if (reason === DECLINE_REASON.OTHER && !trimmedNote) {
      throw new NetworkHttpError(400, "A note is required when the reason is OTHER");
    }
    if (trimmedNote.length > MAX_DECLINE_NOTE) {
      throw new NetworkHttpError(400, `note must be at most ${MAX_DECLINE_NOTE} characters`);
    }
  }

  const effects = [];
  const outcome = await transition(async (t) => {
    const row = await lockAssignment(t, assignmentId);
    if (!row || Number(row.assigned_vendor_id) !== Number(actingVendorId)) {
      throw new NetworkHttpError(404, "Assignment not found");
    }
    const entity = await t.oneOrNone(
      `SELECT status FROM tbl_vendor_org_entities WHERE org_id = $1 AND vendor_id = $2 AND status <> 'REMOVED' FOR SHARE`,
      [row.org_id, actingVendorId]
    );
    if (!entity) throw new NetworkHttpError(404, "Assignment not found");
    if (row.status !== PENDING) {
      throw new NetworkHttpError(409, `This assignment is already ${row.status.toLowerCase().replace("_", " ")}`, "NOT_PENDING");
    }
    const org = await t.one(`SELECT principal_vendor_id FROM tbl_vendor_orgs WHERE id = $1`, [row.org_id]);
    const principalVendorId = org.principal_vendor_id;

    if (row.due_at && new Date(row.due_at).getTime() <= Date.now()) {
      const timedOut = await releaseRow(t, row, TIMED_OUT, { actorUserId: null, reason: "TIMED_OUT" });
      effects.push(effect("release", timedOut, PENDING, { principalVendorId, system: true }));
      return { expired: true };
    }

    if (decision === "DECLINE") {
      const declined = await releaseRow(t, row, DECLINED, {
        actorUserId,
        reason: "DECLINED",
        declineReason: reason,
        declineNote: trimmedNote || null,
      });
      effects.push(effect("release", declined, PENDING, { principalVendorId }));
      return { assignment: declined };
    }

    const can = await entityCanOperate(actingVendorId, t);
    if (!can.ok) throw new NetworkHttpError(403, "This entity cannot take on network work right now", can.reason);

    const live = await liveRowsForUpdate(t, row.subject_type, row.subject_id, row.hotel_id);
    const previous = live.find((r) => r.status === ACCEPTED && r.id !== row.id) ?? null;
    let superseded = null;
    if (previous) {
      superseded = await releaseRow(t, previous, SUPERSEDED, { actorUserId, reason: "SUPERSEDED" });
      effects.push(effect("release", superseded, ACCEPTED, { principalVendorId }));
    }
    const accepted = await t.one(
      `UPDATE tbl_vendor_routing_assignments
          SET status = 'ACCEPTED', acted_by_user_id = $2, acted_at = now()
        WHERE id = $1
        RETURNING *`,
      [row.id, actorUserId ?? null]
    );
    const handler = getSubjectHandler(row.subject_type);
    if (handler?.onAccepted) await handler.onAccepted(accepted, superseded, t);
    effects.push(effect("accept", accepted, PENDING, { principalVendorId }));
    return { assignment: accepted };
  });

  // A timeout found here is the platform's doing, like the sweep's.
  const system = effects.filter((e) => e.system);
  const personal = effects.filter((e) => !e.system);
  await flushEffects(system, { userId: null });
  await flushEffects(personal, { userId: actorUserId ?? null, label: actorLabel });
  if (outcome.expired) {
    throw new NetworkHttpError(409, "This assignment has expired and returned to the network admin", "EXPIRED");
  }
  return outcome.assignment;
}

/** Revokes one live row (inside its own tx). Shared by admin revoke, entity removal and the sweep. */
async function revokeById(assignmentId, { orgId = null, actorUserId = null, actorLabel = null, reason }) {
  const effects = [];
  const revoked = await transition(async (t) => {
    const row = await lockAssignment(t, assignmentId);
    if (!row || (orgId != null && Number(row.org_id) !== Number(orgId))) {
      throw new NetworkHttpError(404, "Assignment not found");
    }
    if (!LIVE.includes(row.status)) {
      throw new NetworkHttpError(409, `This assignment is already ${row.status.toLowerCase().replace("_", " ")}`, "NOT_LIVE");
    }
    const org = await t.one(`SELECT principal_vendor_id FROM tbl_vendor_orgs WHERE id = $1`, [row.org_id]);
    const released = await releaseRow(t, row, REVOKED, { actorUserId, reason });
    effects.push(effect("release", released, row.status, { principalVendorId: org.principal_vendor_id }));
    return released;
  });
  await flushEffects(effects, { userId: actorUserId, label: actorLabel });
  return revoked;
}

/** Admin revoke of a PENDING or ACCEPTED row of its own org (another org's → 404). */
export function revoke({ assignmentId, orgId, actorUserId, actorLabel = null }) {
  return revokeById(assignmentId, { orgId, actorUserId, actorLabel, reason: "ADMIN_REVOKED" });
}

/**
 * Revokes every live (PENDING/ACCEPTED) routing assignment held by `vendorId`, each in
 * its own transaction. Called after commit when an entity is suspended, removed or
 * leaves; a failure on one row is logged and the rest continue (the sweep retries).
 * @returns {Promise<number>} the number of assignments revoked
 */
export async function revokeLiveAssignmentsForEntity(vendorId, { actorUserId = null, reason = "ENTITY_REMOVED" } = {}) {
  const rows = await db.any(
    `SELECT id FROM tbl_vendor_routing_assignments
      WHERE assigned_vendor_id = $1 AND status IN ('PENDING', 'ACCEPTED')
      ORDER BY id`,
    [vendorId]
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      await revokeById(id, { actorUserId, reason });
      count += 1;
    } catch (err) {
      if (err instanceof NetworkHttpError && err.reason === "NOT_LIVE") continue; // raced: already released
      logger.error({ err: err.message, assignmentId: id, vendorId, reason }, "vendor-routing revoke for entity failed");
    }
  }
  return count;
}

/** Times out one PENDING row whose due_at has passed by `now` (sweep). False when it raced. */
export async function timeOut(assignmentId, now = new Date()) {
  const effects = [];
  const done = await transition(async (t) => {
    const row = await lockAssignment(t, assignmentId);
    if (!row || row.status !== PENDING || !row.due_at || new Date(row.due_at).getTime() > now.getTime()) return false;
    const org = await t.one(`SELECT principal_vendor_id FROM tbl_vendor_orgs WHERE id = $1`, [row.org_id]);
    const released = await releaseRow(t, row, TIMED_OUT, { actorUserId: null, reason: "TIMED_OUT" });
    effects.push(effect("release", released, PENDING, { principalVendorId: org.principal_vendor_id }));
    return true;
  });
  await flushEffects(effects, { userId: null });
  return done;
}

/** System revoke (sweep self-healing): the assignee is no longer an ACTIVE entity of the org. */
export function revokeOrphaned(assignmentId) {
  return revokeById(assignmentId, { actorUserId: null, reason: "ENTITY_NOT_ACTIVE" });
}

const LIST_COLUMNS = `
  a.*, u.name AS assignee_name, ent.relationship AS assignee_relationship, ent.status AS assignee_entity_status`;

/** An org's assignments, newest first; `status` may be one status or an array. */
export function listForOrg(orgId, { status = null, subjectType = null, actedSince = null, runner = db } = {}) {
  const statuses = status == null ? null : [].concat(status);
  return runner.any(
    `SELECT ${LIST_COLUMNS}
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

/** Assignments addressed to one entity (default: live ones), newest first. */
export function listForAssignee(vendorId, { status = LIVE, runner = db } = {}) {
  const statuses = status == null ? LIVE : [].concat(status);
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

/**
 * Vendor ids that refused (DECLINED / TIMED_OUT) or were withdrawn from (REVOKED) a
 * subject+hotel of the org, keyed `${subjectType}:${subjectId}:${hotelId ?? 0}`.
 */
export async function priorRefusals(orgId, statuses = [DECLINED, TIMED_OUT], runner = db) {
  const rows = await runner.any(
    `SELECT DISTINCT subject_type, subject_id, COALESCE(hotel_id, 0) AS hotel_key, assigned_vendor_id
       FROM tbl_vendor_routing_assignments
      WHERE org_id = $1 AND status = ANY($2::text[])`,
    [orgId, statuses]
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.subject_type}:${r.subject_id}:${r.hotel_key}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(Number(r.assigned_vendor_id));
  }
  return map;
}

export const subjectKey = (subjectType, subjectId, hotelId) => `${subjectType}:${subjectId}:${hotelId ?? 0}`;

export default {
  registerSubject,
  getSubjectHandler,
  registeredSubjects,
  computeDueAt,
  assign,
  respond,
  revoke,
  revokeLiveAssignmentsForEntity,
  timeOut,
  revokeOrphaned,
  listForOrg,
  listForAssignee,
  priorRefusals,
  subjectKey,
};
