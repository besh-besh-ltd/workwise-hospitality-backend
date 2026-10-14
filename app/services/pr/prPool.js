// Purchase Requisitions — the buyer pool's actions (spec §9, §4.2).
//
//   assign              a PR → one of the hotel's buyers (pr.convert holders).
//   mapLine             a free-text line → a usable, uncontracted catalog
//                       variant (re-mapping allowed until it is sourced); an
//                       open catalog request for the line is fulfilled by it.
//   requestCatalogItem  a free-text, unmapped line → an open catalog request
//                       for the platform team (admin-panel queue + email).
//   closeLine           a buyer ends a line (reason required).
//   cancelLine          the requester withdraws a line they no longer need.
//                       Ending a line rejects its open catalog request (R21).
//
// The header state machine (submit → review → approval) lives in prWorkflow;
// this module only acts on APPROVED PRs, whose lines wait in the pool.
//
// Rules every action here follows:
//   - one db.tx; the PR row is locked (lockPr) first, then the line
//     (lockLineState, FOR UPDATE) — always in that order, so two line actions
//     can never deadlock each other — and the expected state is re-checked
//     under the locks → 409 PR_STATE_CONFLICT, details {line_id, line_no, reason}.
//   - a PR the caller may not read is a 404 (canReadPr, no existence leak);
//     buyer actions then re-assert pr.convert on the PR's OWN hotel (any
//     department) → 403; requester actions answer 404 to everyone else.
//   - "sourced" is LIVE_LINK_EXISTS — the very rule behind the derived
//     progress — so a line the pool shows is a line these actions accept.
//   - every change writes a tbl_pr_event in the same transaction;
//     notifications go out after the commit (prNotify never throws).

import db from '../../config/dbConn.js';
import * as prModel from '../../models/pr/prModel.js';
import { PR_ERR, prError } from './prErrors.js';
import { record } from './prEvents.js';
import { assertPerm, canReadPr, isRequester, notFound } from './prAccess.js';
import { describeVariants, contractCoverage } from './prCatalog.js';
import { MAX_LEN } from './prConstants.js';
import { notifyAssigned, notifyLineClosed, notifyLineCancelled, notifyCatalogRequested } from './prNotify.js';

const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const humanStatus = (s) => String(s).replace(/_/g, ' ');
const INT4_MAX = 2147483647;
function posInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v <= INT4_MAX ? v : null;
  if (typeof v === 'string' && /^\d{1,10}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 && n <= INT4_MAX ? n : null;
  }
  return null;
}

/** The PR's hotel as the scope of pr.convert: the pool is per hotel, any department. */
const hotelScopeOf = (pr) => ({ companyId: Number(pr.hospitality_company_id), hotelId: Number(pr.hotel_id), departmentId: null });

/** Lock the PR; the caller must be able to read it (else 404). */
async function lockReadable(t, prId, user) {
  const pr = prId ? await prModel.lockPr(t, prId) : null;
  if (!pr || !(await canReadPr(user, pr, t))) throw notFound();
  return pr;
}

/** Lock a buyer's PR: readable (else 404) and pr.convert on its hotel (else 403), under the PR lock. */
async function lockForBuyer(t, prId, user) {
  const pr = await lockReadable(t, prId, user);
  await assertPerm(user.id, 'pr.convert', hotelScopeOf(pr), t);
  return pr;
}

/** Lock a line of this PR (after the PR). 404 when it is not one of its lines. */
async function lockLine(t, pr, lineId) {
  const line = lineId ? await prModel.lockLineState(t, pr.id, lineId) : null;
  if (!line) throw prError(PR_ERR.NOT_FOUND, 'Requisition line not found');
  return line;
}

// Why an action cannot run on a line right now — the reason codes of the 409.
const REASON_MESSAGE = {
  not_approved: (pr) => `This requisition is ${humanStatus(pr.status)} — only approved requisitions are in the purchase queue`,
  not_active: (pr, line) => `Line ${line.line_no} is ${humanStatus(line.status)}`,
  already_sourced: (pr, line) => `Line ${line.line_no} is already being sourced on an RFQ`,
  not_free_text: (pr, line) => `Line ${line.line_no} is a catalog item — only free-text lines are mapped or requested`,
  already_mapped: (pr, line) => `Line ${line.line_no} is already mapped to a catalog item`,
  catalog_request_open: (pr, line) => `A catalog request for line ${line.line_no} is already open`,
};
const lineConflict = (pr, line, reason) => prError(
  PR_ERR.STATE_CONFLICT,
  `${REASON_MESSAGE[reason](pr, line)} — refresh to see the latest`,
  { line_id: Number(line.id), line_no: Number(line.line_no), reason, status: pr.status, line_status: line.status });

/**
 * Is `line` (a lockLineState / lineStates row) of `pr` still in play — the PR
 * approved, the line active and not sourced on a live RFQ link? The reason it
 * is not, or null. Shared by close, cancel, map and the detail's
 * can_cancel_lines, so the button and the endpoint can never disagree.
 */
export function lineBlocker(pr, line) {
  if (pr.status !== 'approved') return 'not_approved';
  if (line.status !== 'active') return 'not_active';
  if (line.has_live_link === true) return 'already_sourced';
  return null;
}

// What an ended line's open catalog request is rejected with (R21).
const ENDED_LINE_NOTE = {
  line_closed: 'Line closed — no longer needed',
  line_cancelled: 'Line cancelled — no longer needed',
};

/**
 * End a line (closed / cancelled) inside the caller's transaction, under the
 * locks: the line row, its event, and — when a catalog request was still open
 * for it — that request rejected by the actor (R21: nobody needs the item any
 * more, so it must not sit in the platform team's queue) with its own event.
 */
async function endLineTx(t, pr, line, user, { status, reason }) {
  const why = status === 'closed' ? 'line_closed' : 'line_cancelled';
  await prModel.endLine(t, line.id, { status, reason, userId: user.id });
  const rejected = await prModel.resolveOpenCatalogRequest(t, { lineId: line.id }, {
    status: 'rejected', resolvedBy: user.id, note: ENDED_LINE_NOTE[why],
  });
  await record(t, {
    prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: why,
    payload: { line_no: Number(line.line_no), reason, ...(rejected ? { rejected_catalog_request_id: rejected } : {}) },
  });
  if (rejected) {
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'catalog_rejected',
      payload: { request_id: rejected, reason: why, note: ENDED_LINE_NOTE[why] },
    });
  }
}

/** A required reason (trimmed, ≤ MAX_LEN.reason) or a 422. */
function requiredReason(raw, verb) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason || reason.length > MAX_LEN.reason) {
    throw prError(PR_ERR.VALIDATION, `A reason is required to ${verb} a line`, [{
      field: 'reason', message: reason ? `Must be at most ${MAX_LEN.reason} characters` : 'A reason is required',
    }]);
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * POST /pr/:id/assign {buyer_id}. The caller works the hotel's pool (pr.convert
 * on its hotel); the assignee must be one of the hotel's buyers — the same
 * predicate GET /pr/buyers lists (IS_HOTEL_BUYER_SQL) — else 422; the PR must
 * be approved, else 409. Assigning the current assignee again is a no-op.
 * @returns {Promise<{id, assigned_buyer_id, assigned_buyer_name, assigned_at}>}
 */
export async function assign(prId, user, body) {
  const out = await db.tx(async (t) => {
    const pr = await lockForBuyer(t, prId, user);
    if (pr.status !== 'approved') {
      throw prError(PR_ERR.STATE_CONFLICT,
        `This requisition is ${humanStatus(pr.status)} — only approved requisitions can be assigned`, { status: pr.status });
    }
    const buyerId = posInt(asObject(body).buyer_id);
    const scope = hotelScopeOf(pr);
    if (!buyerId || !(await prModel.isHotelBuyer(buyerId, scope, t))) {
      throw prError(PR_ERR.VALIDATION, 'Assign it to someone who works the purchase queue of this hotel', [{
        field: 'buyer_id', message: 'This person is not a buyer for this hotel',
      }]);
    }
    const from = pr.assigned_buyer_id == null ? null : Number(pr.assigned_buyer_id);
    const toName = await prModel.userName(buyerId, t);
    if (from === buyerId) {
      return { changed: false, pr, result: { id: Number(pr.id), assigned_buyer_id: buyerId, assigned_buyer_name: toName, assigned_at: pr.assigned_at } };
    }
    const after = await prModel.setAssignedBuyer(t, pr.id, buyerId);
    await record(t, {
      prId: pr.id, revision: pr.revision, actorId: user.id, type: 'assigned',
      payload: { from, to: buyerId, from_name: from == null ? null : await prModel.userName(from, t), to_name: toName },
    });
    return {
      changed: true,
      pr: after,
      result: { id: Number(pr.id), assigned_buyer_id: buyerId, assigned_buyer_name: toName, assigned_at: after.assigned_at },
    };
  });
  if (out.changed) {
    await notifyAssigned({ pr: out.pr, assigneeId: out.result.assigned_buyer_id, assigneeName: out.result.assigned_buyer_name, actorId: user.id });
  }
  return out.result;
}

// ---------------------------------------------------------------------------
// Mapping free text to the catalog
// ---------------------------------------------------------------------------

/**
 * POST /pr/:id/lines/:lineId/map {variant_id}. A buyer maps a free-text line
 * of an approved PR — active, not sourced — to a catalog variant the RFQ
 * wizard would accept (USABLE_VARIANT_SQL → else 422 PR_VARIANT_NOT_USABLE)
 * and that is NOT on a live rate contract for the PR's (hotel, department)
 * (else 422 PR_LINE_ON_CONTRACT: raise an MR instead). Re-mapping is allowed
 * until the line is sourced. An open catalog request for the line is
 * fulfilled by this mapping (resolved_by = the buyer, "Mapped by buyer").
 * Mapping to the variant it already has changes nothing.
 * @returns {Promise<{line_id, mapped_variant_id, mapped_variant_name, fulfilled_catalog_request_id, progress}>}
 */
export async function mapLine(prId, lineId, user, body) {
  const out = await db.tx(async (t) => {
    const pr = await lockForBuyer(t, prId, user);
    const line = await lockLine(t, pr, lineId);
    const blocked = lineBlocker(pr, line) ?? (line.line_kind !== 'free_text' ? 'not_free_text' : null);
    if (blocked) throw lineConflict(pr, line, blocked);

    const variantId = posInt(asObject(body).variant_id);
    const variant = variantId ? (await describeVariants([variantId], t)).get(variantId) : null;
    if (!variant) {
      throw prError(PR_ERR.VALIDATION, 'Pick a catalog item to map this line to', [{
        field: 'variant_id', message: variantId ? 'This catalog item does not exist' : 'variant_id is required',
      }]);
    }
    if (!variant.usable) {
      throw prError(PR_ERR.VARIANT_NOT_USABLE, `${variant.name} cannot be requested right now`, {
        line_id: Number(line.id), variant_id: variantId, variant_name: variant.name,
      });
    }
    const contract = (await contractCoverage({ hotelId: pr.hotel_id, departmentId: pr.department_id, variantIds: [variantId] }, t))
      .get(variantId);
    if (contract) {
      throw prError(PR_ERR.LINE_ON_CONTRACT,
        `${variant.name} is on a rate contract for this hotel and department — raise an MR instead`,
        { line_id: Number(line.id), line_no: Number(line.line_no), variant_id: variantId, variant_name: variant.name, ...contract });
    }

    const from = line.mapped_variant_id == null ? null : Number(line.mapped_variant_id);
    if (from === variantId) return { line, variant, variantId, fulfilled: null };
    await prModel.setLineMapping(t, line.id, { variantId, userId: user.id });
    const fulfilled = await prModel.resolveOpenCatalogRequest(t, { lineId: line.id }, {
      status: 'fulfilled', variantId, resolvedBy: user.id, note: 'Mapped by buyer',
    });
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'line_mapped',
      payload: {
        line_no: Number(line.line_no), from, to: variantId, variant_name: variant.name,
        ...(fulfilled ? { fulfilled_catalog_request_id: fulfilled } : {}),
      },
    });
    if (fulfilled) {
      await record(t, {
        prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'catalog_fulfilled',
        payload: { request_id: fulfilled, variant_id: variantId, variant_name: variant.name, resolved_by: 'buyer', note: 'Mapped by buyer' },
      });
    }
    return { line, variant, variantId, fulfilled };
  });
  return {
    line_id: Number(out.line.id),
    mapped_variant_id: out.variantId,
    mapped_variant_name: out.variant.name,
    fulfilled_catalog_request_id: out.fulfilled,
    progress: await prModel.lineProgress(out.line.id),
  };
}

// ---------------------------------------------------------------------------
// Catalog requests
// ---------------------------------------------------------------------------

function parseCatalogRequestBody(body, line) {
  const b = asObject(body);
  const errors = [];
  let requestedName = line.free_text_name;
  if (b.requested_name !== undefined && b.requested_name !== null) {
    if (typeof b.requested_name !== 'string') errors.push({ field: 'requested_name', message: 'requested_name must be text' });
    else requestedName = b.requested_name.trim() || line.free_text_name;
  }
  if (requestedName && requestedName.length > MAX_LEN.requested_name) {
    errors.push({ field: 'requested_name', message: `Must be at most ${MAX_LEN.requested_name} characters` });
  }
  let description = null;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string') errors.push({ field: 'description', message: 'description must be text' });
    else description = b.description.trim() || null;
  }
  if (description && description.length > MAX_LEN.description) {
    errors.push({ field: 'description', message: `Must be at most ${MAX_LEN.description} characters` });
  }
  return { requestedName, description, errors };
}

/**
 * POST /pr/:id/lines/:lineId/catalog-request {requested_name?, description?}.
 * A buyer asks the platform team to add a catalog item for a free-text,
 * unmapped, active, unsourced line of an approved PR. One open request per line
 * (409; the partial unique index backs the check). requested_name defaults to
 * the line's free text. The platform admins learn of it from the admin-panel
 * queue (the primary channel) and, when PR_CATALOG_REQUEST_EMAIL is set, by email.
 * @returns {Promise<{id, line_id, status, requested_name, description}>}
 */
export async function requestCatalogItem(prId, lineId, user, body) {
  const out = await db.tx(async (t) => {
    const pr = await lockForBuyer(t, prId, user);
    const line = await lockLine(t, pr, lineId);
    const blocked = lineBlocker(pr, line)
      ?? (line.line_kind !== 'free_text' ? 'not_free_text' : null)
      ?? (line.mapped_variant_id != null ? 'already_mapped' : null)
      ?? (line.open_catalog_request_id != null ? 'catalog_request_open' : null);
    if (blocked) throw lineConflict(pr, line, blocked);
    const { requestedName, description, errors } = parseCatalogRequestBody(body, line);
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);

    let request;
    try {
      request = await prModel.insertCatalogRequest(t, {
        companyId: Number(pr.hospitality_company_id), lineId: line.id, requestedName, description,
        categoryId: line.category_id, requestedBy: user.id,
      });
    } catch (err) {
      // uq_pr_catreq_open_per_line: unreachable under the PR lock, but the index is the last word.
      if (err?.code === '23505') throw lineConflict(pr, line, 'catalog_request_open');
      throw err;
    }
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: user.id, type: 'catalog_requested',
      payload: { request_id: Number(request.id), line_no: Number(line.line_no), requested_name: requestedName, description },
    });
    return { pr, line, request };
  });
  await notifyCatalogRequested({ pr: out.pr, line: out.line, request: out.request, actorId: user.id });
  return {
    id: Number(out.request.id),
    line_id: Number(out.line.id),
    status: out.request.status,
    requested_name: out.request.requested_name,
    description: out.request.description,
  };
}

// ---------------------------------------------------------------------------
// Ending a line: close (buyer), cancel (requester)
// ---------------------------------------------------------------------------

/**
 * POST /pr/:id/lines/:lineId/close {reason}. A buyer ends an active, unsourced
 * line of an approved PR (e.g. bought locally); an open catalog request for it
 * is rejected "Line closed — no longer needed" (R21); the requester is told.
 * @returns {Promise<{line_id, status: 'closed', progress}>}
 */
export async function closeLine(prId, lineId, user, rawReason) {
  const out = await db.tx(async (t) => {
    const pr = await lockForBuyer(t, prId, user);
    const line = await lockLine(t, pr, lineId);
    const blocked = lineBlocker(pr, line);
    if (blocked) throw lineConflict(pr, line, blocked);
    const reason = requiredReason(rawReason, 'close');
    await endLineTx(t, pr, line, user, { status: 'closed', reason });
    return { pr, line, reason };
  });
  await notifyLineClosed({ pr: out.pr, line: out.line, reason: out.reason, actorId: user.id });
  return { line_id: Number(out.line.id), status: 'closed', progress: await prModel.lineProgress(out.line.id) };
}

/**
 * POST /pr/:id/lines/:lineId/cancel {reason}. The requester withdraws an
 * active line of their approved PR before it is sourced (ownership only, like
 * cancelling the PR — R10); everyone else gets 404. An open catalog request for
 * it is rejected "Line cancelled — no longer needed" (R21). The assigned buyer is told.
 * @returns {Promise<{line_id, status: 'cancelled', progress}>}
 */
export async function cancelLine(prId, lineId, user, rawReason) {
  const out = await db.tx(async (t) => {
    const pr = prId ? await prModel.lockPr(t, prId) : null;
    if (!pr || !isRequester(user, pr)) throw notFound();
    const line = await lockLine(t, pr, lineId);
    const blocked = lineBlocker(pr, line);
    if (blocked) throw lineConflict(pr, line, blocked);
    const reason = requiredReason(rawReason, 'cancel');
    await endLineTx(t, pr, line, user, { status: 'cancelled', reason });
    return { pr, line, reason };
  });
  await notifyLineCancelled({ pr: out.pr, line: out.line, reason: out.reason, actorId: user.id });
  return { line_id: Number(out.line.id), status: 'cancelled', progress: await prModel.lineProgress(out.line.id) };
}

/**
 * The detail's `capabilities.can_cancel_lines`: the line ids the requester may
 * cancel right now (lineBlocker — the endpoint's own rule). [] for anyone else.
 */
export async function cancellableLineIds(pr, user, t = db) {
  if (!isRequester(user, pr) || pr.status !== 'approved') return [];
  const states = await prModel.lineStates(Number(pr.id), t);
  return states.filter((l) => lineBlocker(pr, l) === null).map((l) => Number(l.id));
}

export default { assign, mapLine, requestCatalogItem, closeLine, cancelLine, cancellableLineIds, lineBlocker };
