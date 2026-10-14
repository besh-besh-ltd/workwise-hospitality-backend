// Purchase Requisitions — the platform team's catalog-request queue (spec §10,
// §11; Task 10). Reached from the admin console (jwtAdm) only; `adminId` is the
// platform user's tbl_users.id taken from the admin JWT.
//
//   list     every company's requests, filtered and paged.
//   fulfil   an OPEN request → fulfilled with a usable variant. The line is
//            mapped to it (mapped_by NULL = the platform) only when it is still
//            a free-text, active, unmapped line with no live RFQ link and the
//            variant is not on a rate contract for the PR's (hotel, department);
//            otherwise the line stays as it is and the catalog_fulfilled event
//            says why ({line_mapped:false, reason}).
//   reject   an OPEN request → rejected with a required note; the line derives
//            back to needs_mapping.
//
// Locking. Every buyer-side path (map, close, cancel — prPool) locks PR → line
// and only then touches the request row. This module takes the SAME order
// (PR → line → request): the request is located without a lock, the PR and the
// line are locked, and the request row is then locked and re-checked as OPEN.
// Locking the request first would deadlock against a buyer mapping the same
// line. All pr-side state is read after the locks.

import db from '../../config/dbConn.js';
import * as prModel from '../../models/pr/prModel.js';
import { PR_ERR, prError } from './prErrors.js';
import { record } from './prEvents.js';
import { describeVariants, contractCoverage } from './prCatalog.js';
import { MAX_LEN } from './prConstants.js';
import { notifyCatalogResolved } from './prNotify.js';

export const PAGE_SIZE = 25;
const INT4_MAX = 2147483647;

function posInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v <= INT4_MAX ? v : null;
  if (typeof v === 'string' && /^\d{1,10}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 && n <= INT4_MAX ? n : null;
  }
  return null;
}

const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const requestNotFound = () => prError(PR_ERR.NOT_FOUND, 'Catalog request not found');

/** GET /admin/pr-catalog-requests?status=&q=&page= */
export async function listRequests(query) {
  const raw = asObject(query);
  const status = raw.status === undefined || raw.status === '' ? null : String(raw.status);
  if (status && !prModel.CATALOG_REQUEST_STATUSES.includes(status)) {
    throw prError(PR_ERR.VALIDATION, 'status must be open, fulfilled or rejected', [
      { field: 'status', message: 'status must be open, fulfilled or rejected' }]);
  }
  const q = typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim().slice(0, 200) : null;
  const page = raw.page === undefined || raw.page === '' ? 1 : posInt(raw.page);
  if (!page) throw prError(PR_ERR.VALIDATION, 'page must be a positive integer', [{ field: 'page', message: 'page must be a positive integer' }]);
  return prModel.listCatalogRequests({ status, q, page, pageSize: PAGE_SIZE });
}

/**
 * The locks every resolution takes, in the buyer-side order: PR, line, request.
 * The request must still be OPEN under the locks (else 409).
 */
async function lockForResolution(t, requestId) {
  const where = requestId ? await prModel.catalogRequestLocator(requestId, t) : null;
  if (!where) throw requestNotFound();
  const pr = await prModel.lockPr(t, where.pr_id);
  const line = pr ? await prModel.lockLineState(t, pr.id, where.pr_line_id) : null;
  const request = line ? await prModel.lockCatalogRequest(t, requestId) : null;
  if (!request) throw requestNotFound();
  if (request.status !== 'open') {
    throw prError(PR_ERR.STATE_CONFLICT, `This catalog request is already ${request.status}`, {
      request_id: Number(request.id), status: request.status,
    });
  }
  return { pr, line, request };
}

/** Why the line must keep its current mapping state; null when the variant may be mapped. */
async function unmappableReason(t, pr, line, variantId) {
  if (line.status === 'closed') return 'line_closed';
  if (line.status === 'cancelled') return 'line_cancelled';
  if (line.line_kind !== 'free_text' || line.mapped_variant_id != null) return 'already_mapped';
  if (line.has_live_link) return 'live_link';
  const contract = (await contractCoverage({ hotelId: pr.hotel_id, departmentId: pr.department_id, variantIds: [variantId] }, t))
    .get(variantId);
  return contract ? 'on_contract' : null;
}

/**
 * POST /admin/pr-catalog-requests/:id/fulfil {variant_id, note?}
 * @returns {Promise<{id, status: 'fulfilled', line_id, variant_id, variant_name, line_mapped: boolean, reason?: string}>}
 */
export async function fulfilRequest(requestId, adminId, body) {
  const input = asObject(body);
  const out = await db.tx(async (t) => {
    const { pr, line, request } = await lockForResolution(t, posInt(requestId));

    const variantId = posInt(input.variant_id);
    const variant = variantId ? (await describeVariants([variantId], t)).get(variantId) : null;
    if (!variant) {
      throw prError(PR_ERR.VALIDATION, 'Pick the catalog item that fulfils this request', [{
        field: 'variant_id', message: variantId ? 'This catalog item does not exist' : 'variant_id is required',
      }]);
    }
    let note = null;
    if (input.note !== undefined && input.note !== null) {
      note = typeof input.note === 'string' ? input.note.trim() : null;
      if (note === null || note.length > MAX_LEN.note) {
        throw prError(PR_ERR.VALIDATION, `The note must be at most ${MAX_LEN.note} characters`, [{
          field: 'note', message: `The note must be at most ${MAX_LEN.note} characters`,
        }]);
      }
      note = note || null;
    }
    if (!variant.usable) {
      throw prError(PR_ERR.VARIANT_NOT_USABLE, `${variant.name} cannot be requested right now`, {
        request_id: Number(request.id), variant_id: variantId, variant_name: variant.name,
      });
    }

    const reason = await unmappableReason(t, pr, line, variantId);
    await prModel.resolveCatalogRequest(t, request.id, { status: 'fulfilled', resolvedBy: adminId, note, variantId });
    if (!reason) await prModel.setLineMapping(t, line.id, { variantId, userId: null });

    if (!reason) {
      await record(t, {
        prId: pr.id, lineId: line.id, revision: pr.revision, actorId: adminId, type: 'line_mapped',
        payload: {
          line_no: Number(line.line_no), from: null, to: variantId, variant_name: variant.name,
          fulfilled_catalog_request_id: Number(request.id), by: 'platform', admin_id: adminId,
        },
      });
    }
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: adminId, type: 'catalog_fulfilled',
      payload: {
        request_id: Number(request.id), line_no: Number(line.line_no), variant_id: variantId, variant_name: variant.name,
        resolved_by: 'platform', admin_id: adminId, note,
        line_mapped: !reason, ...(reason ? { reason } : {}),
      },
    });
    return { pr, line, request, variant, variantId, note, reason };
  });
  await notifyCatalogResolved({
    pr: out.pr, line: out.line, request: out.request, outcome: 'fulfilled',
    variantName: out.variant.name, note: out.note, actorId: adminId,
  });
  return {
    id: Number(out.request.id), status: 'fulfilled', line_id: Number(out.line.id),
    variant_id: out.variantId, variant_name: out.variant.name,
    line_mapped: !out.reason, ...(out.reason ? { reason: out.reason } : {}),
  };
}

/**
 * POST /admin/pr-catalog-requests/:id/reject {note}
 * @returns {Promise<{id, status: 'rejected', line_id}>}
 */
export async function rejectRequest(requestId, adminId, body) {
  const raw = asObject(body).note;
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (!note || note.length > MAX_LEN.note) {
    const message = note ? `The note must be at most ${MAX_LEN.note} characters` : 'Say why the request is declined';
    throw prError(PR_ERR.VALIDATION, message, [{ field: 'note', message }]);
  }
  const out = await db.tx(async (t) => {
    const { pr, line, request } = await lockForResolution(t, posInt(requestId));
    await prModel.resolveCatalogRequest(t, request.id, { status: 'rejected', resolvedBy: adminId, note });
    await record(t, {
      prId: pr.id, lineId: line.id, revision: pr.revision, actorId: adminId, type: 'catalog_rejected',
      payload: { request_id: Number(request.id), line_no: Number(line.line_no), resolved_by: 'platform', admin_id: adminId, note },
    });
    return { pr, line, request };
  });
  await notifyCatalogResolved({
    pr: out.pr, line: out.line, request: out.request, outcome: 'rejected', note, actorId: adminId,
  });
  return { id: Number(out.request.id), status: 'rejected', line_id: Number(out.line.id) };
}

export default { listRequests, fulfilRequest, rejectRequest, PAGE_SIZE };
