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
  refuseGuest,
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
  refusalStatuses,
  subjectKey,
} from "../../services/vendorNetwork/routingEngine.js";
import { resolveCoverageCandidates } from "../../services/vendorNetwork/coverage.js";
import { getOrgById } from "../../models/vendorNetworkModel.js";
import { ASSIGNMENT_STATUS, SUBJECT_TYPE } from "../../constants/vendorNetwork.js";

const { PENDING, ACCEPTED, DECLINED, TIMED_OUT } = ASSIGNMENT_STATUS;
const RECENT_DAYS = 7;
// Queue rows whose suggestions are computed at once (each may use a pool connection).
const SUGGESTION_CONCURRENCY = 4;
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

/**
 * Ranked candidates minus the entities that already declined or timed out on this item,
 * and those left out with why: { candidates, excluded: [{ vendor_id, name, reason }] }
 * where reason is the refusal's status (DECLINED | TIMED_OUT). `refused` is the item's
 * Map<vendorId, status> from refusalStatuses.
 */
async function suggestionsFor(orgId, { hotelIds, categoryId }, refused, liveIds) {
  const ranked = await resolveCoverageCandidates({ orgId, hotelIds, categoryId: categoryId ?? null });
  const candidates = [];
  const excluded = [];
  for (const c of ranked) {
    const id = Number(c.entity_vendor_id);
    // The item's live assignee (PENDING / ACCEPTED) is never a refusal, even when it
    // declined earlier and was then assigned again by hand.
    const reason = liveIds?.has(id) ? null : refused?.get(id);
    if (reason) excluded.push({ vendor_id: id, name: c.name, reason });
    else candidates.push(candidateView(c));
  }
  return { candidates, excluded };
}

/** GET /routing/queue */
export async function routingQueue(req, res) {
  try {
    const denied = requireOrgAdmin(req);
    if (denied) return res.status(denied.http).json(denied.body);
    const orgId = req.user.network.org_id;
    const { principal_vendor_id: principalVendorId } = await getOrgById(orgId);
    const refused = await refusalStatuses(orgId);

    // Live assignments first: their assignees are never listed as refusals.
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000);
    const [pending, accepted, declinedRows] = await Promise.all([
      listForOrg(orgId, { status: PENDING }).then(withDescription),
      listForOrg(orgId, { status: ACCEPTED }).then(withDescription),
      listForOrg(orgId, { status: [DECLINED, TIMED_OUT], actedSince: since }).then(withDescription),
    ]);
    const liveByKey = new Map();
    for (const row of [...pending, ...accepted]) {
      const key = subjectKey(row.subject_type, row.subject_id, row.hotel_id);
      if (!liveByKey.has(key)) liveByKey.set(key, new Set());
      liveByKey.get(key).add(Number(row.assigned_vendor_id));
    }

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
          ...(await suggestionsFor(orgId, item, refused.get(key), liveByKey.get(key))),
        };
        unroutedByKey.set(key, view);
        unrouted.push(view);
      }
    }

    // Suggestions for a routed row: the unrouted entry's when the item is back in the
    // queue; otherwise the subject is re-validated for its hotels.
    // One re-validation per subject key, however many rows share it. validateSubject only
    // reads (no locks), each in its own short transaction as the handlers expect.
    const suggestionsByKey = new Map();
    const suggestionsOf = (row) => {
      const key = subjectKey(row.subject_type, row.subject_id, row.hotel_id);
      const queued = unroutedByKey.get(key);
      if (queued) return Promise.resolve({ candidates: queued.candidates, excluded: queued.excluded });
      if (!suggestionsByKey.has(key)) {
        suggestionsByKey.set(
          key,
          (async () => {
            try {
              const handler = getSubjectHandler(row.subject_type);
              const scope = { orgId, principalVendorId, subjectId: row.subject_id, hotelId: row.hotel_id };
              const valid = handler ? await db.tx((t) => handler.validateSubject(scope, t)) : null;
              if (valid?.ok) return await suggestionsFor(orgId, valid, refused.get(key), liveByKey.get(key));
            } catch (err) {
              // A subject that can no longer be routed simply has no candidates.
              logger.warn({ err: err.message, assignmentId: row.id }, "vendor-routing queue re-validation failed");
            }
            return { candidates: [], excluded: [] };
          })()
        );
      }
      return suggestionsByKey.get(key);
    };

    // Declined / timed-out items, and pending ones (so a reassignment is offered the same
    // suggestions, the pending assignee among them), SUGGESTION_CONCURRENCY at a time so a
    // long queue cannot take the whole connection pool.
    const rowsNeedingSuggestions = [...declinedRows, ...pending];
    const suggested = new Array(rowsNeedingSuggestions.length);
    for (let i = 0; i < rowsNeedingSuggestions.length; i += SUGGESTION_CONCURRENCY) {
      const chunk = rowsNeedingSuggestions.slice(i, i + SUGGESTION_CONCURRENCY);
      const results = await Promise.all(chunk.map(suggestionsOf));
      results.forEach((r, j) => {
        suggested[i + j] = { ...chunk[j], ...r };
      });
    }
    const declined = suggested.slice(0, declinedRows.length);
    const pendingWithSuggestions = suggested.slice(declinedRows.length);

    return res.status(200).json({
      status: 1,
      message: "Routing queue",
      data: { unrouted, pending: pendingWithSuggestions, accepted, declined },
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
    // An emailed-link guest session cannot accept or decline network work (Task 23).
    const denied = refuseGuest(req) ?? requireNetwork(req);
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
