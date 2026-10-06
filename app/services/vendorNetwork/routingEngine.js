// Vendor Networks routing engine (spec §6.2): one assignment state machine for every
// subject type, with the subject-specific work delegated to a registered handler.
//
//   assign ─▶ PENDING ──accept──▶ ACCEPTED ──(another accepted)──▶ SUPERSEDED
//                │  ├─decline──▶ DECLINED
//                │  ├─due_at ──▶ TIMED_OUT   (routingSweep)
//                │  └─revoke ──▶ REVOKED     (admin, entity removal; ACCEPTED too)
//
// A routing subject belongs to ONE org: it is keyed (org_id, subject_type, subject_id,
// hotel_id), because several orgs may each route the same RFQ. Every transition runs in
// one db.tx that first takes a transaction advisory lock on that key and then SELECT …
// FOR UPDATE on the org's live rows of the subject, so two transitions on one subject
// serialise even when no row exists yet. The partial unique indexes (one PENDING, one
// ACCEPTED per org+subject+hotel) are the backstop: a 23505 on them surfaces as 409.
// Notifications and emails go out after commit and never fail the transition. The
// assignment rows themselves are the audit trail (assigned_by_user_id / acted_by_user_id
// are the person; NULL for the sweep).
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
//       the org's subjects with no PENDING/ACCEPTED row OF THAT ORG

import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import { sendMail } from "../../helper/common.js";
import { generateEmailTemplate } from "../../helper/notificationEmailLayout.js";
import { dispatch as dispatchNotification } from "../notificationService.js";
import { NetworkHttpError } from "./guards.js";
import { entityCanOperate } from "./actingContext.js";
import { getOrgById } from "../../models/vendorNetworkModel.js";
import {
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
  listOrgAssigneesByStatus,
  listOrgAssignments,
  listAssigneeAssignments,
} from "../../models/vendorRoutingModel.js";
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

/**
 * Handler refusals ({http, message, code}) and races on the routing unique indexes as
 * NetworkHttpError; any other error (including other unique violations) propagates.
 */
function asNetworkError(err) {
  if (err instanceof NetworkHttpError) return err;
  if (err && Number.isInteger(err.http)) {
    return new NetworkHttpError(err.http, err.message || "Request refused", err.code ?? err.reason);
  }
  if (err?.code === UNIQUE_VIOLATION && ROUTING_UNIQUE_INDEXES.includes(err.constraint)) {
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

const subjectOf = (row) => ({
  orgId: row.org_id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  hotelId: row.hotel_id,
});

/**
 * Locks the subject of assignment `id` and returns the row FOR UPDATE, or null.
 * The subject lock comes first (same order as assign), then the row.
 */
async function lockAssignment(t, id) {
  const peek = await getAssignment(id, t);
  if (!peek) return null;
  await lockRoutingSubject(t, subjectOf(peek));
  return getAssignment(id, t, { forUpdate: true });
}

/** Moves a live row to a terminal status and runs the handler's onReleased. */
async function releaseRow(t, row, toStatus, { actorUserId, reason, declineReason = null, declineNote = null }) {
  const updated = await releaseAssignment(t, row.id, {
    status: toStatus,
    actorUserId: actorUserId ?? null,
    declineReason,
    declineNote,
  });
  const handler = getSubjectHandler(row.subject_type);
  const released = { ...updated, release_reason: reason };
  if (handler?.onReleased) await handler.onReleased(released, row.status, t);
  return released;
}

/** A post-commit side effect: the transitioned row and the principal to tell. */
const effect = (assignment, principalVendorId) => ({ assignment, principalVendorId });

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

/** The assignee entity's email plus its ACTIVE member persons' emails in the org, de-duplicated. */
async function assigneeEmails(orgId, vendorId) {
  const seen = new Set();
  return (await listAssigneeEmails(orgId, vendorId))
    .map((e) => (typeof e === "string" ? e.trim() : ""))
    .filter((e) => e && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function emailAssignee(assignment, described) {
  try {
    const recipients = await assigneeEmails(assignment.org_id, assignment.assigned_vendor_id);
    if (!recipients.length) return;
    const base = (process.env.FRONT_BASE_URL || DEFAULT_FRONT_BASE_URL).replace(/\/+$/, "");
    const link = `${base}${ASSIGNED_URL}`;
    const due = assignment.due_at
      ? new Date(assignment.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : null;
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

const PRINCIPAL_TITLES = {
  [ACCEPTED]: "Assignment accepted",
  [DECLINED]: "Assignment declined",
  [TIMED_OUT]: "Assignment timed out",
};

/** Runs the post-commit side effects of one transition. Never throws. */
async function flushEffects(effects) {
  for (const { assignment: a, principalVendorId } of effects) {
    try {
      const described = await safeDescribe(a);
      const data = {
        assignment_id: a.id,
        subject_type: a.subject_type,
        subject_id: a.subject_id,
        hotel_id: a.hotel_id,
        assigned_vendor_id: a.assigned_vendor_id,
      };
      if (a.status === PENDING) {
        await notify({
          userIds: [a.assigned_vendor_id],
          type: "NETWORK_ROUTING_ASSIGNED",
          title: "New assignment",
          body: `${described.title} has been routed to you. Accept or decline it.`,
          actionUrl: described.actionUrl || ASSIGNED_URL,
          data: { ...data, due_at: a.due_at },
        });
        await emailAssignee(a, described);
      } else if (a.status === REVOKED) {
        await notify({
          userIds: [a.assigned_vendor_id],
          type: "NETWORK_ROUTING_REVOKED",
          title: "Assignment withdrawn",
          body: `${described.title} is no longer assigned to you.`,
          actionUrl: ASSIGNED_URL,
          data,
        });
      } else if (PRINCIPAL_TITLES[a.status] && principalVendorId) {
        const assigneeName = (await getUserDisplayName(a.assigned_vendor_id)) || "A network entity";
        const body =
          a.status === ACCEPTED
            ? `${assigneeName} accepted ${described.title}.`
            : a.status === DECLINED
              ? `${assigneeName} declined ${described.title} (${a.decline_reason}${a.decline_note ? `: ${a.decline_note}` : ""}). It is back in your routing queue.`
              : `${assigneeName} did not respond to ${described.title} in time. It is back in your routing queue.`;
        await notify({
          userIds: [principalVendorId],
          type: `NETWORK_ROUTING_${a.status}`,
          title: PRINCIPAL_TITLES[a.status],
          body,
          actionUrl: ROUTING_URL,
          data: { ...data, decline_reason: a.decline_reason ?? null },
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, "vendor-routing post-commit effect failed");
    }
  }
}

// --- public API -----------------------------------------------------------------------

/** due_at = max(now + 1h, min(now + timeoutHours, dueCap)); a dueCap that is not a valid Date is ignored. */
export function computeDueAt(now, timeoutHours, dueCap = null) {
  let due = now.getTime() + Number(timeoutHours) * HOUR_MS;
  const cap = dueCap instanceof Date ? dueCap.getTime() : NaN;
  if (Number.isFinite(cap)) due = Math.min(due, cap);
  return new Date(Math.max(due, now.getTime() + RFQ_DUE_FLOOR_HOURS_FROM_NOW * HOUR_MS));
}

/**
 * Routes a subject (+hotel) of `orgId` to a member entity: a new PENDING row. The org's
 * PENDING row for the same subject+hotel is REVOKED; an ACCEPTED one stays until the new
 * one is accepted. `ifUnrouted` (sweep auto-routing) makes it a no-op returning null when
 * the org already has a live row for the subject.
 */
export async function assign({
  orgId,
  subjectType,
  subjectId,
  hotelId = null,
  assigneeVendorId,
  actorUserId,
  autoRouted = false,
  ifUnrouted = false,
}) {
  const handler = getSubjectHandler(subjectType);
  if (!handler) throw new NetworkHttpError(400, `Unknown subject type ${subjectType}`, "UNKNOWN_SUBJECT");

  const effects = [];
  const subject = { orgId, subjectType, subjectId, hotelId: hotelId ?? null };
  const created = await transition(async (t) => {
    const org = await getOrgById(orgId, t);
    if (!org) throw new NetworkHttpError(404, "Network not found");

    await lockRoutingSubject(t, subject);
    const live = await lockLiveRowsForSubject(t, subject);
    if (ifUnrouted && live.length) return null;

    // The assignee: an ACTIVE, non-principal entity of this org that may operate. FOR SHARE
    // holds off a concurrent suspend/remove until this commits (its revoke then sees the row).
    const entity = await getOrgEntityForShare(orgId, assigneeVendorId, t);
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
      { orgId, principalVendorId: org.principal_vendor_id, subjectId, hotelId: subject.hotelId },
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
      effects.push(effect(released, org.principal_vendor_id));
    }

    const row = await insertPendingAssignment(t, {
      ...subject,
      assigneeVendorId,
      dueAt: computeDueAt(new Date(), org.routing_timeout_hours, valid.dueCap ?? null),
      autoRouted,
      assignedByUserId: actorUserId ?? null,
    });
    if (handler.onPending) await handler.onPending(row, t);
    effects.push(effect(row, org.principal_vendor_id));
    return row;
  });
  if (created) await flushEffects(effects);
  return created;
}

/**
 * The assignee (any person acting as `actingVendorId`) accepts or declines a PENDING row.
 * Not the assignee → 404 (existence is not leaked). Past due_at → it times out here and 409.
 */
export async function respond({ assignmentId, actingVendorId, actorUserId, decision, reason, note }) {
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
    if (!(await getOrgEntityForShare(row.org_id, actingVendorId, t))) {
      throw new NetworkHttpError(404, "Assignment not found");
    }
    if (row.status !== PENDING) {
      throw new NetworkHttpError(409, `This assignment is already ${row.status.toLowerCase().replace("_", " ")}`, "NOT_PENDING");
    }
    const { principal_vendor_id: principalVendorId } = await getOrgById(row.org_id, t);

    if (row.due_at && new Date(row.due_at).getTime() <= Date.now()) {
      // A timeout found here is the platform's doing, like the sweep's: no acting person.
      const timedOut = await releaseRow(t, row, TIMED_OUT, { actorUserId: null, reason: "TIMED_OUT" });
      effects.push(effect(timedOut, principalVendorId));
      return { expired: true };
    }

    if (decision === "DECLINE") {
      const declined = await releaseRow(t, row, DECLINED, {
        actorUserId,
        reason: "DECLINED",
        declineReason: reason,
        declineNote: trimmedNote || null,
      });
      effects.push(effect(declined, principalVendorId));
      return { assignment: declined };
    }

    const can = await entityCanOperate(actingVendorId, t);
    if (!can.ok) throw new NetworkHttpError(403, "This entity cannot take on network work right now", can.reason);

    const live = await lockLiveRowsForSubject(t, subjectOf(row));
    const previous = live.find((r) => r.status === ACCEPTED && r.id !== row.id) ?? null;
    let superseded = null;
    if (previous) {
      superseded = await releaseRow(t, previous, SUPERSEDED, { actorUserId, reason: "SUPERSEDED" });
      effects.push(effect(superseded, principalVendorId));
    }
    const accepted = await acceptAssignment(t, row.id, actorUserId ?? null);
    const handler = getSubjectHandler(row.subject_type);
    if (handler?.onAccepted) await handler.onAccepted(accepted, superseded, t);
    effects.push(effect(accepted, principalVendorId));
    return { assignment: accepted };
  });

  await flushEffects(effects);
  if (outcome.expired) {
    throw new NetworkHttpError(409, "This assignment has expired and returned to the network admin", "EXPIRED");
  }
  return outcome.assignment;
}

/** Revokes one live row (inside its own tx). Shared by admin revoke, entity removal and the sweep. */
async function revokeById(assignmentId, { orgId = null, actorUserId = null, reason }) {
  const effects = [];
  const revoked = await transition(async (t) => {
    const row = await lockAssignment(t, assignmentId);
    if (!row || (orgId != null && Number(row.org_id) !== Number(orgId))) {
      throw new NetworkHttpError(404, "Assignment not found");
    }
    if (!LIVE.includes(row.status)) {
      throw new NetworkHttpError(409, `This assignment is already ${row.status.toLowerCase().replace("_", " ")}`, "NOT_LIVE");
    }
    const { principal_vendor_id: principalVendorId } = await getOrgById(row.org_id, t);
    const released = await releaseRow(t, row, REVOKED, { actorUserId, reason });
    effects.push(effect(released, principalVendorId));
    return released;
  });
  await flushEffects(effects);
  return revoked;
}

/** Admin revoke of a PENDING or ACCEPTED row of its own org (another org's → 404). */
export function revoke({ assignmentId, orgId, actorUserId }) {
  return revokeById(assignmentId, { orgId, actorUserId, reason: "ADMIN_REVOKED" });
}

/**
 * Revokes every live (PENDING/ACCEPTED) routing assignment held by `vendorId` in `orgId`
 * (in every org when orgId is null), each in its own transaction. Called after commit when
 * an entity is suspended, removed or leaves; a failure on one row is logged and the rest
 * continue (the sweep's self-healing retries it).
 * @returns {Promise<number>} the number of assignments revoked
 */
export async function revokeLiveAssignmentsForEntity(
  vendorId,
  { actorUserId = null, reason = "ENTITY_REMOVED", orgId = null } = {}
) {
  let count = 0;
  for (const id of await listLiveAssignmentIdsForEntity(vendorId, orgId)) {
    try {
      await revokeById(id, { orgId, actorUserId, reason });
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
    const { principal_vendor_id: principalVendorId } = await getOrgById(row.org_id, t);
    const released = await releaseRow(t, row, TIMED_OUT, { actorUserId: null, reason: "TIMED_OUT" });
    effects.push(effect(released, principalVendorId));
    return true;
  });
  await flushEffects(effects);
  return done;
}

/** System revoke (sweep self-healing): the assignee is no longer an ACTIVE entity of the org. */
export function revokeOrphaned(assignmentId) {
  return revokeById(assignmentId, { actorUserId: null, reason: "ENTITY_NOT_ACTIVE" });
}

/** An org's assignments, newest first; `status` may be one status or an array. */
export function listForOrg(orgId, { status = null, subjectType = null, actedSince = null } = {}) {
  return listOrgAssignments(orgId, {
    statuses: status == null ? null : [].concat(status),
    subjectType,
    actedSince,
  });
}

/** Assignments addressed to one entity (default: live ones), newest first. */
export function listForAssignee(vendorId, { status = LIVE } = {}) {
  return listAssigneeAssignments(vendorId, status == null ? LIVE : [].concat(status));
}

export const subjectKey = (subjectType, subjectId, hotelId) => `${subjectType}:${subjectId}:${hotelId ?? 0}`;

/**
 * Vendor ids of the org's rows in `statuses` (default: those that refused, DECLINED /
 * TIMED_OUT), keyed by subjectKey(type, id, hotel).
 */
export async function priorRefusals(orgId, statuses = [DECLINED, TIMED_OUT]) {
  const map = new Map();
  for (const r of await listOrgAssigneesByStatus(orgId, statuses)) {
    const key = subjectKey(r.subject_type, r.subject_id, Number(r.hotel_key) || null);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(Number(r.assigned_vendor_id));
  }
  return map;
}

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
