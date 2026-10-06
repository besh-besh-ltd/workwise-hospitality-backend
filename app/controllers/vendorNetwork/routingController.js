// Vendor Networks routing API (spec §6.2, §10.5, §10.7, §10.10).
//
//   GET  /routing/queue            admin: unrouted subjects + live and recent assignments,
//                                  with ranked candidates for unrouted / declined items
//   POST /routing/assign           admin: { subject_type, subject_id, hotel_id?, assignee_vendor_id }
//   POST /routing/:id/revoke       admin
//   GET  /routing/assigned-to-me   any network entity: its assignments (?status=)
//   POST /routing/:id/respond      the assignee: { decision: ACCEPT|DECLINE, reason?, note? }
//
// The org is always req.user.network.org_id and the acting entity req.user.id; body ids are
// targets the engine verifies against that org. Another org's assignment, or one addressed
// to a sibling entity, answers 404 so its existence is never revealed.

import db from "../../config/dbConn.js";
import Config from "../../config/app.config.js";
import { logger } from "../../util/logger.js";
import {
  requireNetwork,
  requireOrgAdmin,
  actingPersonId,
  NetworkHttpError,
  sendIfNetworkError,
} from "../../services/vendorNetwork/guards.js";
import {
  assign,
  respond,
  revoke,
  listForOrg,
  listForAssignee,
  registeredSubjects,
  getSubjectHandler,
  priorRefusals,
  subjectKey,
} from "../../services/vendorNetwork/routingEngine.js";
import { resolveCoverageCandidates } from "../../services/vendorNetwork/coverage.js";
import { getOrgById } from "../../models/vendorNetworkModel.js";
import { ASSIGNMENT_STATUS, SUBJECT_TYPE } from "../../constants/vendorNetwork.js";

const { PENDING, ACCEPTED, DECLINED, TIMED_OUT } = ASSIGNMENT_STATUS;
const RECENT_DAYS = 7;
const SUBJECT_TYPES = Object.values(SUBJECT_TYPE);
const STATUSES = Object.values(ASSIGNMENT_STATUS);

/** A positive int4 from a number or a digit string, else null. */
function parseId(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

const fail = (res, http, message) => res.status(http).json({ status: 0, message });

function handleError(res, error, label) {
  if (sendIfNetworkError(res, error)) return res;
  logger.error({ err: error.message }, `vendor-network ${label} failed`);
  return res.status(400).json({ status: 3, message: Config.errorText.value });
}

/** The handler's title and link for a row; a failing describe never fails the list. */
async function described(row) {
  try {
    const d = await getSubjectHandler(row.subject_type)?.describe?.(row, db);
    return { title: d?.title ?? null, action_url: d?.actionUrl ?? null };
  } catch (err) {
    logger.warn({ err: err.message, assignmentId: row.id }, "vendor-routing describe failed");
    return { title: null, action_url: null };
  }
}

const withDescription = (rows) => Promise.all(rows.map(async (r) => ({ ...r, ...(await described(r)) })));

const candidateView = (c) => ({
  vendor_id: Number(c.entity_vendor_id),
  name: c.name,
  specificity: c.specificity,
  preference_rank: c.preference_rank,
  covers_all_hotels: c.covers_all_hotels,
  hotels_covered: c.hotels_covered,
});

/** Ranked candidates minus the entities that already declined or timed out on this item. */
async function candidatesFor(orgId, { hotelIds, categoryId }, excluded) {
  const ranked = await resolveCoverageCandidates({ orgId, hotelIds, categoryId: categoryId ?? null });
  return ranked.filter((c) => !excluded?.has(Number(c.entity_vendor_id))).map(candidateView);
}

/** GET /routing/queue */
export async function routingQueue(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const orgId = req.user.network.org_id;
    const { principal_vendor_id: principalVendorId } = await getOrgById(orgId);
    const refused = await priorRefusals(orgId);

    const unrouted = [];
    const unroutedByKey = new Map();
    for (const [subjectType, handler] of registeredSubjects()) {
      if (!handler.listUnrouted) continue;
      // One failing subject type must not hide the others' queue.
      let items;
      try {
        items = (await handler.listUnrouted(orgId, db)) ?? [];
      } catch (err) {
        logger.warn({ err: err.message, orgId, subjectType }, "vendor-routing listUnrouted failed");
        continue;
      }
      for (const item of items) {
        const key = subjectKey(subjectType, item.subjectId, item.hotelId);
        const view = {
          subject_type: subjectType,
          subject_id: item.subjectId,
          hotel_id: item.hotelId ?? null,
          hotel_ids: item.hotelIds ?? [],
          category_id: item.categoryId ?? null,
          title: item.title ?? null,
          meta: item.meta ?? null,
          candidates: await candidatesFor(orgId, item, refused.get(key)),
        };
        unroutedByKey.set(key, view);
        unrouted.push(view);
      }
    }

    const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000);
    const [pending, accepted, declinedRows] = await Promise.all([
      listForOrg(orgId, { status: PENDING }).then(withDescription),
      listForOrg(orgId, { status: ACCEPTED }).then(withDescription),
      listForOrg(orgId, { status: [DECLINED, TIMED_OUT], actedSince: since }).then(withDescription),
    ]);

    // Declined / timed-out items: the unrouted entry's candidates when the item is back in
    // the queue; otherwise (already re-routed) the subject is re-validated for its hotels.
    const declined = [];
    for (const row of declinedRows) {
      const key = subjectKey(row.subject_type, row.subject_id, row.hotel_id);
      let candidates = unroutedByKey.get(key)?.candidates;
      if (!candidates) {
        candidates = [];
        try {
          const handler = getSubjectHandler(row.subject_type);
          const scope = { orgId, principalVendorId, subjectId: row.subject_id, hotelId: row.hotel_id };
          const valid = handler ? await db.tx((t) => handler.validateSubject(scope, t)) : null;
          if (valid?.ok) candidates = await candidatesFor(orgId, valid, refused.get(key));
        } catch (err) {
          // A subject that can no longer be routed simply has no candidates.
          logger.warn({ err: err.message, assignmentId: row.id }, "vendor-routing queue re-validation failed");
        }
      }
      declined.push({ ...row, candidates });
    }

    return res.status(200).json({
      status: 1,
      message: "Routing queue",
      data: { unrouted, pending, accepted, declined },
    });
  } catch (error) {
    return handleError(res, error, "routingQueue");
  }
}

/** POST /routing/assign { subject_type, subject_id, hotel_id?, assignee_vendor_id } */
export async function assignSubject(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);

    const { subject_type: subjectType } = req.body ?? {};
    const subjectId = parseId(req.body?.subject_id);
    const hotelId = req.body?.hotel_id == null ? null : parseId(req.body.hotel_id);
    const assigneeVendorId = parseId(req.body?.assignee_vendor_id);
    if (!SUBJECT_TYPES.includes(subjectType)) return fail(res, 400, `subject_type must be one of ${SUBJECT_TYPES.join(", ")}`);
    if (!subjectId) return fail(res, 400, "subject_id is required");
    if (req.body?.hotel_id != null && !hotelId) return fail(res, 400, "Invalid hotel_id");
    if (!assigneeVendorId) return fail(res, 400, "assignee_vendor_id is required");

    const row = await assign({
      orgId: req.user.network.org_id,
      subjectType,
      subjectId,
      hotelId,
      assigneeVendorId,
      actorUserId: actingPersonId(req),
    });
    return res.status(201).json({ status: 1, message: "Assigned", data: row });
  } catch (error) {
    return handleError(res, error, "assignSubject");
  }
}

/** POST /routing/:id/revoke */
export async function revokeAssignment(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const id = parseId(req.params.id);
    if (!id) throw new NetworkHttpError(404, "Assignment not found");
    const row = await revoke({
      assignmentId: id,
      orgId: req.user.network.org_id,
      actorUserId: actingPersonId(req),
    });
    return res.status(200).json({ status: 1, message: "Assignment revoked", data: row });
  } catch (error) {
    return handleError(res, error, "revokeAssignment");
  }
}

/** GET /routing/assigned-to-me[?status=PENDING,ACCEPTED] */
export async function assignedToMe(req, res) {
  try {
    const denied = requireNetwork(req);
    if (denied) return res.status(denied.http).json(denied.body);
    let status;
    if (typeof req.query?.status === "string" && req.query.status.trim()) {
      status = req.query.status.split(",").map((s) => s.trim().toUpperCase());
      if (status.some((s) => !STATUSES.includes(s))) return fail(res, 400, `status must be among ${STATUSES.join(", ")}`);
    }
    const rows = await listForAssignee(req.user.id, status ? { status } : {});
    return res.status(200).json({ status: 1, message: "Assignments", data: await withDescription(rows) });
  } catch (error) {
    return handleError(res, error, "assignedToMe");
  }
}

/** POST /routing/:id/respond { decision, reason?, note? } */
export async function respondToAssignment(req, res) {
  try {
    const denied = requireNetwork(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const id = parseId(req.params.id);
    if (!id) throw new NetworkHttpError(404, "Assignment not found");
    const { decision, reason, note } = req.body ?? {};
    const row = await respond({
      assignmentId: id,
      actingVendorId: req.user.id,
      actorUserId: actingPersonId(req),
      decision,
      reason,
      note,
    });
    return res.status(200).json({
      status: 1,
      message: row.status === ACCEPTED ? "Assignment accepted" : "Assignment declined",
      data: row,
    });
  } catch (error) {
    return handleError(res, error, "respondToAssignment");
  }
}

export default { routingQueue, assignSubject, revokeAssignment, assignedToMe, respondToAssignment };
