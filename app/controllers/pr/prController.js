// Purchase Requisitions (PR) — buyer-side controller (spec 2026-10-13).
//
// Contract for every handler here:
//   - Scope comes from req.user and the PR row. The ONLY client-chosen scope is
//     hotel_id/department_id on create/update, and that cell is then verified
//     with pr.create before anything is written.
//   - Every state change runs in one db.tx, row-locks the PR (lockPr), and
//     re-checks the expected status → 409 PR_STATE_CONFLICT otherwise.
//   - Every mutation writes a tbl_pr_event in the same transaction.
//   - The response is sent AFTER the transaction commits (see mrController
//     createDraft: answering inside db.tx can put a 200 on the wire before
//     COMMIT, and a re-read can then miss the row).
//   - A PR the caller may not read is a 404, never a 403 (no existence leak).
//     Requester-only mutations answer 404 to everyone but the requester.

import db from '../../config/dbConn.js';
import { logger } from '../../util/logger.js';
import * as prModel from '../../models/pr/prModel.js';
import { PR_ERR, prError, sendPrError } from '../../services/pr/prErrors.js';
import { record } from '../../services/pr/prEvents.js';
import {
  hasPerm, assertPerm, canReadPr, forbiddenMessage, isSuperAdmin, cellOf, isRequester, notFound,
} from '../../services/pr/prAccess.js';
import { userCanReadEntity } from '../../services/authorizationService.js';
import { describeVariants, contractCoverage, guardCatalogLines } from '../../services/pr/prCatalog.js';
import { previewRouting } from '../../services/pr/prRouting.js';
import * as prWorkflow from '../../services/pr/prWorkflow.js';
import * as prPool from '../../services/pr/prPool.js';
import * as prConversion from '../../services/pr/prConversion.js';
import { getApprovalInstanceDetails } from '../../models/generalModel.js';
import { formatPaise } from '../../services/approval/approvalEntityRules.js';
import {
  PR_TYPES, URGENCIES, PR_STATUSES, HEADER_PROGRESSES, EDITABLE_STATUSES, WITHDRAWABLE_STATUSES, MAX_LINES,
  QTY_RE, PRICE_RE, PRICE_MAX_INT_DIGITS, TOTAL_MAX_PAISE, MAX_LEN, POOL_PROGRESSES,
} from '../../services/pr/prConstants.js';

const ok = (res, data, message = 'success') => res.status(200).json({ status: 1, message, data });

const INT4_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Parsing helpers (never throw)
// ---------------------------------------------------------------------------
function posInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v <= INT4_MAX ? v : null;
  if (typeof v === 'string' && /^\d{1,10}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 && n <= INT4_MAX ? n : null;
  }
  return null;
}
const text = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const decimalText = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const hasNonZeroDigit = (s) => /[1-9]/.test(s);
const toScaled = (s, scale) => {
  const [i, f = ''] = s.split('.');
  return BigInt(i + f.padEnd(scale, '0'));
};
function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// Line money/quantity rules, shared by every endpoint that accepts lines
// (draft create/replace, routing preview). Values stay strings end to end.
const QTY_MESSAGE = 'Quantity must be a positive number with at most 3 decimals';
const PRICE_MESSAGE = 'Estimated unit price must be a positive amount with at most 2 decimals (max 99,999,999,999,999.99)';
/** A valid quantity (NUMERIC(18,3), > 0) as its canonical text, else null. */
function parseQuantity(v) {
  const q = decimalText(v);
  return q != null && QTY_RE.test(q) && hasNonZeroDigit(q) ? q : null;
}
/** A valid estimated unit price (NUMERIC(18,2), > 0, ≤ 14 integer digits) as text, else null. */
function parseUnitPrice(v) {
  const p = decimalText(v);
  return p != null && PRICE_RE.test(p) && hasNonZeroDigit(p)
    && p.split('.')[0].replace(/^0+/, '').length <= PRICE_MAX_INT_DIGITS ? p : null;
}
/**
 * Line value ROUND(qty × price, 2) in paise: qty has 3 decimals, price 2 → 5;
 * half-up back to paise (values are positive, so this equals Postgres ROUND).
 */
const lineValuePaise = (quantity, price) => (toScaled(quantity, 3) * toScaled(price, 2) + 500n) / 1000n;

/**
 * Plain validator for a create/replace payload. Collects EVERY problem (no
 * early return) so the form can highlight them all at once.
 * `istToday` is 'YYYY-MM-DD' from Postgres (session-timezone independent).
 * Money and quantities stay strings end to end.
 *
 * @returns {{ header, lines, errors: Array<{field, message, line_no?}> }}
 */
export function validateDraftBody(body, { istToday }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const err = (field, message, extra = {}) => errors.push({ field, message, ...extra });
  const tooLong = (field, value, extra) => {
    if (value && value.length > MAX_LEN[field]) err(field, `Must be at most ${MAX_LEN[field]} characters`, extra);
  };

  const hotel_id = posInt(b.hotel_id);
  if (!hotel_id) err('hotel_id', 'Choose a hotel');
  const department_id = posInt(b.department_id);
  if (!department_id) err('department_id', 'Choose a department');

  const title = text(b.title);
  if (!title) err('title', 'Title is required');
  tooLong('title', title);

  const justification = text(b.justification);
  if (!justification) err('justification', 'Justification is required');
  tooLong('justification', justification);

  const required_by_date = text(b.required_by_date);
  if (!isIsoDate(required_by_date)) err('required_by_date', 'Need-by date must be a valid date (YYYY-MM-DD)');
  else if (required_by_date < istToday) err('required_by_date', 'Need-by date cannot be in the past');

  const pr_type = b.pr_type == null || b.pr_type === '' ? 'goods' : text(b.pr_type);
  if (!PR_TYPES.includes(pr_type)) err('pr_type', `Type must be one of ${PR_TYPES.join(', ')}`);
  const urgency = b.urgency == null || b.urgency === '' ? 'normal' : text(b.urgency);
  if (!URGENCIES.includes(urgency)) err('urgency', `Urgency must be one of ${URGENCIES.join(', ')}`);

  const delivery_location = text(b.delivery_location) || null;
  tooLong('delivery_location', delivery_location);

  const lines = [];
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    err('lines', 'Add at least one line');
  } else if (b.lines.length > MAX_LINES) {
    err('lines', `A requisition can have at most ${MAX_LINES} lines`);
  } else {
    let totalPaise = 0n;
    const seenIds = new Set();
    b.lines.forEach((raw, i) => {
      const line_no = i + 1;
      const r = raw && typeof raw === 'object' ? raw : {};
      const lerr = (field, message) => err(field, message, { line_no });

      // An existing line keeps its identity (and its clauses/attachments) by
      // sending its `id`; whether the id belongs to THIS PR is checked later.
      let id = null;
      if (r.id !== undefined && r.id !== null && r.id !== '') {
        id = posInt(r.id);
        if (!id) lerr('id', 'Invalid line id');
        else if (seenIds.has(id)) lerr('id', 'The same line appears twice');
        else seenIds.add(id);
      }

      const hasVariant = r.product_variant_id !== undefined && r.product_variant_id !== null && r.product_variant_id !== '';
      const freeText = text(r.free_text_name);
      let line_kind = null;
      if (hasVariant && freeText) lerr('line_kind', 'A line is either a catalog item or free text, not both');
      else if (!hasVariant && !freeText) lerr('line_kind', 'Pick a catalog item or describe the item');
      else line_kind = hasVariant ? 'catalog' : 'free_text';

      let product_variant_id = null;
      let category_id = null;
      if (line_kind === 'catalog') {
        product_variant_id = posInt(r.product_variant_id);
        if (!product_variant_id) lerr('product_variant_id', 'Invalid catalog item');
        // category_id is derived from the product server-side; any client value is ignored.
      } else if (line_kind === 'free_text') {
        if (freeText.length > MAX_LEN.free_text_name) lerr('free_text_name', `Must be at most ${MAX_LEN.free_text_name} characters`);
        category_id = posInt(r.category_id);
        if (!category_id) lerr('category_id', 'Choose a category for a free-text line');
      }

      const validQty = parseQuantity(r.quantity);
      const quantity = validQty ?? decimalText(r.quantity);
      if (!validQty) lerr('quantity', QTY_MESSAGE);

      const validPrice = parseUnitPrice(r.estimated_unit_price);
      const price = validPrice ?? decimalText(r.estimated_unit_price);
      if (!validPrice) lerr('estimated_unit_price', PRICE_MESSAGE);

      const uom = text(r.uom);
      if (!uom) lerr('uom', 'Unit is required');
      else if (uom.length > MAX_LEN.uom) lerr('uom', `Must be at most ${MAX_LEN.uom} characters`);

      const specification = text(r.specification) || null;
      if (specification && specification.length > MAX_LEN.specification) lerr('specification', `Must be at most ${MAX_LEN.specification} characters`);
      const suggested_vendor_note = text(r.suggested_vendor_note) || null;
      if (suggested_vendor_note && suggested_vendor_note.length > MAX_LEN.suggested_vendor_note) {
        lerr('suggested_vendor_note', `Must be at most ${MAX_LEN.suggested_vendor_note} characters`);
      }

      if (validQty && validPrice) totalPaise += lineValuePaise(validQty, validPrice);

      lines.push({
        id, line_no, line_kind, product_variant_id, category_id,
        free_text_name: line_kind === 'free_text' ? freeText : null,
        quantity, uom, estimated_unit_price: price, specification, suggested_vendor_note,
      });
    });
    if (totalPaise > TOTAL_MAX_PAISE) err('lines', 'The estimated total of this requisition is too large');
  }

  return {
    header: { hotel_id, department_id, title, justification, required_by_date, pr_type, urgency, delivery_location },
    lines,
    errors,
  };
}

/**
 * Shared by create and update: validate, authorize the chosen cell with
 * pr.create, then run the catalog guards. Authorization precedes field errors
 * so a caller without access learns nothing about the payload's validity.
 * `existingLineIds`: the PR's current line ids (empty on create) — a body line
 * may only carry one of these.
 */
async function prepareDraft(t, userId, body, { existingLineIds = new Set() } = {}) {
  const v = validateDraftBody(body, { istToday: await prModel.istToday(t) });
  if (v.errors.some((e) => e.field === 'hotel_id' || e.field === 'department_id')) {
    throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', v.errors);
  }
  const hotel = await prModel.hotelCell(v.header.hotel_id, t);
  if (!hotel) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.create'));
  const cell = {
    companyId: Number(hotel.hospitality_company_id), hotelId: v.header.hotel_id, departmentId: v.header.department_id,
  };
  await assertPerm(userId, 'pr.create', cell, t);
  const foreignIds = v.lines
    .filter((l) => l.id && !existingLineIds.has(l.id))
    .map((l) => ({ field: 'id', line_no: l.line_no, message: 'This line does not belong to this requisition' }));
  const errors = [...v.errors, ...foreignIds];
  if (errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', errors);
  if (!(await prModel.departmentExists(cell.departmentId, t))) {
    throw prError(PR_ERR.VALIDATION, 'Unknown department', [{ field: 'department_id', message: 'Unknown department' }]);
  }
  const lines = await guardCatalogLines(t, cell, v.lines);
  return { cell, header: v.header, lines };
}

const headerRow = (cell, header) => ({
  hospitality_company_id: cell.companyId,
  hotel_id: cell.hotelId,
  department_id: cell.departmentId,
  title: header.title,
  pr_type: header.pr_type,
  urgency: header.urgency,
  required_by_date: header.required_by_date,
  justification: header.justification,
  delivery_location: header.delivery_location,
});

const DIFF_KEYS = ['title', 'pr_type', 'urgency', 'required_by_date', 'justification', 'delivery_location', 'hotel_id', 'department_id'];
function headerDiff(before, after) {
  const changed = {};
  for (const k of DIFF_KEYS) {
    const from = before[k] ?? null;
    const to = after[k] ?? null;
    if (String(from ?? '') !== String(to ?? '')) changed[k] = { from, to };
  }
  return changed;
}

/** Booleans the FE renders actions from. Later tasks add convert keys. */
async function capabilitiesFor(user, pr) {
  const requester = isRequester(user, pr);
  const mayCreate = requester && (await hasPerm(user.id, 'pr.create', cellOf(pr)));
  const editable = EDITABLE_STATUSES.includes(pr.status);
  return {
    can_edit: mayCreate && editable,
    // Same gate as submit: the requester, pr.create on the PR's cell, draft/returned.
    can_submit: mayCreate && editable,
    can_withdraw: requester && WITHDRAWABLE_STATUSES.includes(pr.status),
    can_cancel: requester && editable,
    can_copy: mayCreate,
    // Approve / Reject / Send back: null unless the PR is pending_approval;
    // computed by the engine's own decision gate (prWorkflow.decisionRights).
    approval: await prWorkflow.decisionRights(pr, user),
    // Technical review: {review_id, can_edit_lines} for an eligible reviewer of
    // an open review, else null — the gate every reviewer endpoint applies
    // (prWorkflow.reviewRights / prModel.eligibleReviews).
    review: await prWorkflow.reviewRights(pr, user),
    // Lines the requester may cancel now (approved PR, active, not sourced) —
    // the cancel-line endpoint's own rule (prPool.lineBlocker). [] otherwise.
    can_cancel_lines: await prPool.cancellableLineIds(pr, user),
  };
}

/**
 * The engine's view of the PR's current (or last) approval instance — steps,
 * approvers, action history, skipped-step diagnostics and can_user_approve —
 * the shape the MR detail renders its chain from. null when there is none.
 */
async function approvalDetail(user, pr) {
  if (!pr.approval_instance_id) return null;
  try {
    const a = await getApprovalInstanceDetails(Number(pr.approval_instance_id), user.id);
    return a && a.entity_type === 'PR' && Number(a.entity_id) === Number(pr.id) ? a : null;
  } catch (err) {
    logger.warn({ err, prId: pr.id }, '[PR] approval detail unavailable');
    return null;
  }
}

/** GET /pr/:id's payload: the detail, the caller's capabilities and the approval chain (else 404). */
async function detailPayload(user, id) {
  const pr = await prModel.getPrRow(id);
  if (!pr || !(await canReadPr(user, pr))) throw notFound();
  const detail = await prModel.getDetail(id);
  if (!detail) throw notFound();
  return { ...detail, capabilities: await capabilitiesFor(user, pr), approval: await approvalDetail(user, pr) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /v1/pr — create a draft. */
export async function create(req, res) {
  try {
    const userId = req.user.id;
    const out = await db.tx(async (t) => {
      const { cell, header, lines } = await prepareDraft(t, userId, req.body);
      const pr = await prModel.insertPr(t, {
        pr_number: await prModel.nextPrNumber(t),
        raised_by: userId,
        ...headerRow(cell, header),
      });
      await prModel.replaceLines(t, pr.id, lines);
      await record(t, { prId: pr.id, revision: 0, actorId: userId, type: 'created', payload: { line_count: lines.length } });
      return { id: pr.id, pr_number: pr.pr_number };
    });
    return ok(res, out, 'Purchase requisition draft created');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * PUT /v1/pr/:id — replace a draft/returned PR's header and lines. Requester
 * only. Lines sent with their `id` are updated in place (clauses, attachments
 * and review links survive); lines without one are added; lines left out are
 * deleted.
 */
export async function update(req, res) {
  try {
    const userId = req.user.id;
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await db.tx(async (t) => {
      const pr = await prModel.lockPr(t, id);
      if (!pr || !isRequester(req.user, pr)) throw notFound();
      if (!EDITABLE_STATUSES.includes(pr.status)) {
        throw prError(PR_ERR.STATE_CONFLICT, `This requisition is ${pr.status.replace('_', ' ')} and can no longer be edited`, { status: pr.status });
      }
      const body = { ...(req.body && typeof req.body === 'object' ? req.body : {}) };
      if (body.hotel_id === undefined || body.hotel_id === null) body.hotel_id = pr.hotel_id;
      if (body.department_id === undefined || body.department_id === null) body.department_id = pr.department_id;
      const existingLineIds = new Set(await prModel.lineIds(id, t));
      const { cell, header, lines } = await prepareDraft(t, userId, body, { existingLineIds });

      const patch = headerRow(cell, header);
      await prModel.updateHeader(t, id, patch);
      const r = await prModel.replaceLines(t, id, lines);
      await record(t, {
        prId: id, revision: pr.revision, actorId: userId, type: 'updated',
        payload: {
          changed: headerDiff(pr, patch),
          lines: { before: existingLineIds.size, after: lines.length, kept: r.kept, added: r.added, removed: r.removed },
        },
      });
      return { id, pr_number: pr.pr_number };
    });
    return ok(res, out, 'Purchase requisition updated');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/:id — detail + capabilities + approval chain, for anyone who may read the PR (else 404). */
export async function getById(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await detailPayload(req.user, id));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// ---------------------------------------------------------------------------
// Submit, withdraw, approver send-back (Task 6). The transitions live in
// services/pr/prWorkflow.js; each answers with the fresh detail after commit.
// ---------------------------------------------------------------------------

/**
 * POST /v1/pr/:id/submit — draft/returned → in_review | pending_approval.
 * Requester only, with pr.create on the PR's cell. Any body is ignored (the
 * total is recomputed server-side).
 */
export async function submit(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.submit(id, req.user);
    const message = out.status === 'in_review' ? 'Submitted for technical review' : 'Submitted for approval';
    return ok(res, await detailPayload(req.user, id), message);
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/withdraw — in_review | pending_approval → draft. Requester only. */
export async function withdraw(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    await prWorkflow.withdraw(id, req.user);
    return ok(res, await detailPayload(req.user, id), 'Purchase requisition withdrawn');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/send-back {note} — pending_approval → returned. A pending approver of the current step. */
export async function sendBack(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    await prWorkflow.approverSendBack(id, req.user, req.body?.note);
    return ok(res, await detailPayload(req.user, id), 'Sent back to the requester');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// ---------------------------------------------------------------------------
// Technical review (Task 7): the reviewer's queue, line edits, files, and the
// review outcome. Who may act is decided in prWorkflow at action time.
// ---------------------------------------------------------------------------

/** GET /v1/pr/review-queue — the open reviews the caller may act on now, oldest first. */
export async function reviewQueue(req, res) {
  try {
    const rows = await prModel.reviewQueue(req.user.id);
    const items = rows.map((r) => ({
      review_id: Number(r.review_id),
      pr_id: Number(r.pr_id),
      pr_number: r.pr_number,
      title: r.title,
      hotel_name: r.hotel_name,
      department_title: r.department_title,
      requester_name: r.requester_name,
      line_count: r.line_count,
      submitted_at: r.submitted_at,
      age_days: r.age_days,
    }));
    return ok(res, { count: items.length, items });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** PUT /v1/pr/:id/lines/:lineId/specification {specification} — a reviewer of the line's open review. */
export async function editLineSpecification(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.editSpecification(id, posInt(req.params.lineId), req.user, req.body);
    return ok(res, out, 'Specification updated');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/lines/:lineId/clauses {clause_text, clause_type?, weightage?} — a reviewer of the line. */
export async function addLineClause(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.addClause(id, posInt(req.params.lineId), req.user, req.body);
    return ok(res, out, 'Clause added');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** DELETE /v1/pr/:id/lines/:lineId/clauses/:clauseId — a reviewer of the line. */
export async function removeLineClause(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.removeClause(id, posInt(req.params.lineId), posInt(req.params.clauseId), req.user);
    return ok(res, out, 'Clause removed');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/attachments {pr_line_id|null, kind, file_url, file_name} — requester (draft/returned) or reviewer (own lines). */
export async function addAttachment(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.addAttachment(id, req.user, req.body);
    return ok(res, out, 'File attached');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** DELETE /v1/pr/:id/attachments/:attId — same rules; in review only the uploader or the requester. */
export async function removeAttachment(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.removeAttachment(id, posInt(req.params.attId), req.user);
    return ok(res, out, 'File removed');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * POST /v1/pr/:id/reviews/:reviewId/complete {note?} — an eligible reviewer.
 * The last open review starts the approval chain in the same transaction; a
 * broken chain answers 422 with its code and the review stays pending.
 */
export async function completeReview(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await prWorkflow.completeReview(id, posInt(req.params.reviewId), req.user, req.body);
    const message = out.status === 'pending_approval' ? 'Review completed — sent for approval' : 'Review completed';
    return ok(res, await detailPayload(req.user, id), message);
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/reviews/:reviewId/send-back {note} — an eligible reviewer; in_review → returned. */
export async function sendBackReview(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    await prWorkflow.reviewSendBack(id, posInt(req.params.reviewId), req.user, req.body?.note);
    return ok(res, await detailPayload(req.user, id), 'Sent back to the requester');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// The approval engine's terminal-outcome hooks for entity_type 'PR'. The
// registries (approvalActionService, approvalPropagationService) lazy-load them
// from this controller, as they do for every other entity type.
export const { handlePrPostApproval, handlePrRejection } = prWorkflow;

/** POST /v1/pr/:id/cancel {reason} — draft/returned → cancelled (terminal). Requester only. */
export async function cancel(req, res) {
  try {
    const userId = req.user.id;
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    await db.tx(async (t) => {
      const pr = await prModel.lockPr(t, id);
      if (!pr || !isRequester(req.user, pr)) throw notFound();
      if (!EDITABLE_STATUSES.includes(pr.status)) {
        throw prError(PR_ERR.STATE_CONFLICT, `This requisition is ${pr.status.replace('_', ' ')} and cannot be cancelled`, { status: pr.status });
      }
      const reason = text(req.body?.reason);
      if (!reason || reason.length > MAX_LEN.reason) {
        throw prError(PR_ERR.VALIDATION, 'A reason is required to cancel', [{
          field: 'reason', message: reason ? `Must be at most ${MAX_LEN.reason} characters` : 'A reason is required',
        }]);
      }
      await prModel.updateHeader(t, id, { status: 'cancelled', cancelled_reason: reason });
      await record(t, {
        prId: id, revision: pr.revision, actorId: userId, type: 'cancelled', payload: { reason, from_status: pr.status },
      });
    });
    return ok(res, { id, status: 'cancelled' }, 'Purchase requisition cancelled');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * POST /v1/pr/:id/copy — a new draft from any PR the caller raised, in any
 * status. Needs pr.create on the source cell today. Lines are copied as they
 * stand (re-validated at save/submit, not here), without clauses, attachments,
 * mapping or line status.
 */
export async function copy(req, res) {
  try {
    const userId = req.user.id;
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    const out = await db.tx(async (t) => {
      const src = await prModel.getPrRow(id, t);
      if (!src || !isRequester(req.user, src)) throw notFound();
      await assertPerm(userId, 'pr.create', cellOf(src), t);
      const pr = await prModel.copyPr(t, id, { prNumber: await prModel.nextPrNumber(t), raisedBy: userId });
      await record(t, {
        prId: pr.id, revision: 0, actorId: userId, type: 'copied_from',
        payload: { source_pr_id: src.id, source_pr_number: src.pr_number },
      });
      return { id: pr.id, pr_number: pr.pr_number };
    });
    return ok(res, out, 'Copied as a new draft');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/form/hotels — hotels where the caller holds pr.create. */
export async function formHotels(req, res) {
  try {
    return ok(res, { hotels: await prModel.formHotels(req.user.id) });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** Resolve + authorize a hotel from the query for pr.create (department optional). */
async function authorizeCreateCell(req, { requireDepartment }) {
  const hotelId = posInt(req.query.hotel_id);
  const departmentId = posInt(req.query.department_id);
  const errors = [];
  if (!hotelId) errors.push({ field: 'hotel_id', message: 'hotel_id is required' });
  if (requireDepartment && !departmentId) errors.push({ field: 'department_id', message: 'department_id is required' });
  if (errors.length) throw prError(PR_ERR.VALIDATION, 'Missing parameters', errors);
  const hotel = await prModel.hotelCell(hotelId);
  const cell = {
    companyId: hotel ? Number(hotel.hospitality_company_id) : null,
    hotelId,
    departmentId: requireDepartment ? departmentId : null,
  };
  if (!hotel) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.create'));
  await assertPerm(req.user.id, 'pr.create', cell);
  return cell;
}

/** GET /v1/pr/form/departments?hotel_id= — departments at the hotel where the caller holds pr.create. */
export async function formDepartments(req, res) {
  try {
    const cell = await authorizeCreateCell(req, { requireDepartment: false });
    return ok(res, { departments: await prModel.formDepartments(req.user.id, cell) });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * The catalog search's (company, hotel, department), R20. Two callers:
 *   - a requester picking lines: pr.create on that cell (unchanged);
 *   - a buyer mapping a free-text line: pr.convert on the hotel (any
 *     department — the pool is per hotel). The department (the PR's, sent by
 *     the FE) only decides which contracts flag on_contract, so it must be a
 *     real department (else 422).
 * The company always comes from the hotel row; anyone else → 403.
 */
async function authorizeSearchCell(req) {
  const hotelId = posInt(req.query.hotel_id);
  const departmentId = posInt(req.query.department_id);
  const errors = [];
  if (!hotelId) errors.push({ field: 'hotel_id', message: 'hotel_id is required' });
  if (!departmentId) errors.push({ field: 'department_id', message: 'department_id is required' });
  if (errors.length) throw prError(PR_ERR.VALIDATION, 'Missing parameters', errors);
  const hotel = await prModel.hotelCell(hotelId);
  const refused = () => prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.create'), { permission: 'pr.create' });
  if (!hotel) throw refused();
  const cell = { companyId: Number(hotel.hospitality_company_id), hotelId, departmentId };
  if (await hasPerm(req.user.id, 'pr.create', cell)) return cell;
  if (await hasPerm(req.user.id, 'pr.convert', { ...cell, departmentId: null })) {
    if (!(await prModel.departmentExists(departmentId))) {
      throw prError(PR_ERR.VALIDATION, 'Unknown department', [{ field: 'department_id', message: 'Unknown department' }]);
    }
    return cell;
  }
  throw refused();
}

/**
 * GET /v1/pr/search-items?hotel_id=&department_id=&q= — usable catalog
 * variants for the line picker (requester) and the mapping dialog (buyer),
 * flagged when on a rate contract for the cell (the FE blocks those with
 * "raise an MR instead"; save and map refuse them too).
 */
export async function searchItems(req, res) {
  try {
    const cell = await authorizeSearchCell(req);
    const q = text(req.query.q).slice(0, 100);
    if (q.length < 2) return ok(res, { items: [] });
    const limit = Math.min(Math.max(posInt(req.query.limit) || 25, 1), 50);
    const rows = await prModel.searchItems({ q, limit });
    const coverage = await contractCoverage({
      hotelId: cell.hotelId, departmentId: cell.departmentId, variantIds: rows.map((r) => r.variant_id),
    });
    const items = rows.map((r) => {
      const c = coverage.get(Number(r.variant_id));
      return {
        variant_id: Number(r.variant_id),
        variant_name: r.variant_name,
        product_name: r.product_name,
        category_id: Number(r.category_id),
        category_title: r.category_title,
        on_contract: Boolean(c),
        arc_contract_id: c?.arc_contract_id ?? null,
        arc_number: c?.arc_number ?? null,
      };
    });
    return ok(res, { items });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/categories?q= — active categories for free-text lines (any buyer). */
export async function categories(req, res) {
  try {
    const q = text(req.query.q).slice(0, 100);
    return ok(res, { categories: await prModel.searchCategories({ q, limit: 50 }) });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// ---------------------------------------------------------------------------
// List, KPIs, duplicate hints (Task 4)
// ---------------------------------------------------------------------------
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/**
 * GET /v1/pr?tab=mine|all&status=&hotel_id=&department_id=&pr_type=&urgency=&progress=&q=&page=&page_size=
 * Scope is derived from req.user only (mine = raised_by me; all = the same
 * predicate GET /:id uses; super admin = everything, as canReadPr).
 */
export async function list(req, res) {
  try {
    const qs = req.query || {};
    const errors = [];
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const tab = text(one(qs.tab)) || 'mine';
    if (tab !== 'mine' && tab !== 'all') errors.push({ field: 'tab', message: 'tab must be mine or all' });
    const enumFilter = (field, allowed, key = field) => {
      const v = text(one(qs[key]));
      if (!v) return null;
      if (!allowed.includes(v)) { errors.push({ field, message: `Invalid ${field}` }); return null; }
      return v;
    };
    const idFilter = (field) => {
      const raw = one(qs[field]);
      if (raw === undefined || raw === null || raw === '') return null;
      const n = posInt(raw);
      if (!n) errors.push({ field, message: `Invalid ${field}` });
      return n;
    };
    const filters = {
      tab,
      status: enumFilter('status', PR_STATUSES),
      hotelId: idFilter('hotel_id'),
      departmentId: idFilter('department_id'),
      prType: enumFilter('pr_type', PR_TYPES),
      urgency: enumFilter('urgency', URGENCIES),
      progress: enumFilter('progress', HEADER_PROGRESSES),
      q: text(one(qs.q)).slice(0, 100),
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    };
    if (qs.page !== undefined && qs.page !== '') {
      const n = posInt(one(qs.page));
      if (!n) errors.push({ field: 'page', message: 'Invalid page' }); else filters.page = n;
    }
    if (qs.page_size !== undefined && qs.page_size !== '') {
      const n = posInt(one(qs.page_size));
      if (!n) errors.push({ field: 'page_size', message: 'Invalid page_size' });
      else filters.pageSize = Math.min(n, MAX_PAGE_SIZE);
    }
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Invalid query', errors);
    return ok(res, await prModel.list(req.user, filters, isSuperAdmin(req.user)));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/kpis — counters over the caller's readable set. */
export async function kpis(req, res) {
  try {
    return ok(res, await prModel.kpis(req.user, isSuperAdmin(req.user)));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * GET /v1/pr/duplicates?hotel_id=&variant_id= — similar open PRs / RFQs in the
 * caller's company. The company comes from the hotel, and only holders of a PR
 * permission on that hotel may ask. Items the caller cannot read are listed
 * (that is the point of the hint) but without a title.
 */
export async function duplicates(req, res) {
  try {
    const hotelId = posInt(req.query.hotel_id);
    const variantId = posInt(req.query.variant_id);
    const errors = [];
    if (!hotelId) errors.push({ field: 'hotel_id', message: 'hotel_id is required' });
    if (!variantId) errors.push({ field: 'variant_id', message: 'variant_id is required' });
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Missing parameters', errors);

    const hotel = await prModel.hotelCell(hotelId);
    const superAdmin = isSuperAdmin(req.user);
    if (!hotel) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.read'));
    const companyId = Number(hotel.hospitality_company_id);
    if (!superAdmin) {
      const cell = { companyId, hotelId, departmentId: null };
      const allowed = (await hasPerm(req.user.id, 'pr.create', cell))
        || (await hasPerm(req.user.id, 'pr.read', cell))
        || (await hasPerm(req.user.id, 'pr.convert', cell));
      if (!allowed) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.read'));
    }

    const { prs, rfqs } = await prModel.duplicates(req.user, { companyId, variantId }, superAdmin);
    const items = prs.map((r) => {
      const item = {
        kind: 'pr', id: Number(r.id), number: r.number, hotel_name: r.hotel_name,
        department_name: r.department_name, created_at: r.created_at, readable: r.readable === true,
      };
      if (item.readable) item.title = r.title;
      return item;
    });
    const rfqItems = await Promise.all(rfqs.map(async (r) => {
      const readable = superAdmin || Number(r.created_by) === Number(req.user.id)
        || (await userCanReadEntity(req.user.id, 'rfq', r));
      const item = {
        kind: 'rfq', id: Number(r.id), number: r.number, hotel_name: r.hotel_name,
        department_name: r.department_name, created_at: null, last_activity_at: r.last_activity_at, readable,
      };
      if (readable) item.title = r.title;
      return item;
    }));
    items.push(...rfqItems);
    return ok(res, { count: items.length, items });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// ---------------------------------------------------------------------------
// Routing preview (Task 5): who reviews which lines, who approves, and what
// would block submit — computed by prRouting.previewRouting, the function
// submit uses, so the preview and the refusal can never disagree.
// ---------------------------------------------------------------------------

/**
 * Validate a preview body: the cell, and lines identified by product_variant_id
 * (catalog; category derived server-side) or category_id (free text), each with
 * quantity and estimated unit price under the draft rules. Client totals and
 * any other field are ignored.
 * @returns {{ hotelId, departmentId, lines: Array<{line_no, product_variant_id, category_id, quantity, price}>,
 *             cellErrors, errors, totalPaise }}
 */
function validatePreviewBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const cellErrors = [];
  const hotelId = posInt(b.hotel_id);
  if (!hotelId) cellErrors.push({ field: 'hotel_id', message: 'Choose a hotel' });
  const departmentId = posInt(b.department_id);
  if (!departmentId) cellErrors.push({ field: 'department_id', message: 'Choose a department' });

  const errors = [];
  const lines = [];
  let totalPaise = 0n;
  if (b.lines !== undefined && !Array.isArray(b.lines)) {
    errors.push({ field: 'lines', message: 'lines must be a list' });
  } else if ((b.lines || []).length > MAX_LINES) {
    errors.push({ field: 'lines', message: `A requisition can have at most ${MAX_LINES} lines` });
  } else {
    (b.lines || []).forEach((raw, i) => {
      const line_no = i + 1;
      const r = raw && typeof raw === 'object' ? raw : {};
      const lerr = (field, message) => errors.push({ field, message, line_no });
      const hasVariant = r.product_variant_id !== undefined && r.product_variant_id !== null && r.product_variant_id !== '';
      const product_variant_id = hasVariant ? posInt(r.product_variant_id) : null;
      const category_id = hasVariant ? null : posInt(r.category_id);
      if (hasVariant && !product_variant_id) lerr('product_variant_id', 'Invalid catalog item');
      if (!hasVariant && !category_id) lerr('category_id', 'Pick a catalog item or choose a category');
      const quantity = parseQuantity(r.quantity);
      if (!quantity) lerr('quantity', QTY_MESSAGE);
      const price = parseUnitPrice(r.estimated_unit_price);
      if (!price) lerr('estimated_unit_price', PRICE_MESSAGE);
      if (quantity && price) totalPaise += lineValuePaise(quantity, price);
      lines.push({ line_no, product_variant_id, category_id, quantity, price });
    });
    if (totalPaise > TOTAL_MAX_PAISE) errors.push({ field: 'lines', message: 'The estimated total of this requisition is too large' });
  }
  return { hotelId, departmentId, lines, cellErrors, errors, totalPaise };
}

/**
 * Server-derive each line's category: a catalog line takes its product's
 * category (an unknown, unusable or uncategorised variant is a validation
 * error — the preview never routes a line save would refuse); a free-text
 * line's category must be active.
 */
async function previewLineCategories(t, lines) {
  const catalog = lines.filter((l) => l.product_variant_id);
  const freeText = lines.filter((l) => !l.product_variant_id);
  const variants = await describeVariants(catalog.map((l) => l.product_variant_id), t);
  const categories = await prModel.activeCategoryIds(freeText.map((l) => l.category_id), t);
  const errors = [];
  const out = lines.map((l) => {
    if (l.product_variant_id) {
      const v = variants.get(l.product_variant_id);
      if (!v || !v.usable || v.category_id == null) {
        errors.push({
          field: 'product_variant_id', line_no: l.line_no,
          message: v ? 'This catalog item can no longer be requested' : 'This catalog item does not exist',
        });
        return null;
      }
      return { line_no: l.line_no, category_id: v.category_id };
    }
    if (!categories.has(l.category_id)) {
      errors.push({ field: 'category_id', line_no: l.line_no, message: 'This category does not exist or is inactive' });
      return null;
    }
    return { line_no: l.line_no, category_id: l.category_id };
  });
  if (errors.length) throw prError(PR_ERR.VALIDATION, 'Some lines reference items or categories that cannot be requested', errors);
  return out;
}

/**
 * POST /v1/pr/routing-preview {hotel_id, department_id, lines} — the routing an
 * unsaved PR would get, for the caller as requester. Needs pr.create on the
 * cell; the amount is computed here (client totals ignored).
 */
export async function routingPreview(req, res) {
  try {
    const userId = req.user.id;
    const v = validatePreviewBody(req.body);
    if (v.cellErrors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', [...v.cellErrors, ...v.errors]);
    const out = await db.task(async (t) => {
      const hotel = await prModel.hotelCell(v.hotelId, t);
      if (!hotel) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.create'));
      const cell = { companyId: Number(hotel.hospitality_company_id), hotelId: v.hotelId, departmentId: v.departmentId };
      await assertPerm(userId, 'pr.create', cell, t);
      if (v.errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', v.errors);
      if (!(await prModel.departmentExists(cell.departmentId, t))) {
        throw prError(PR_ERR.VALIDATION, 'Unknown department', [{ field: 'department_id', message: 'Unknown department' }]);
      }
      const lines = await previewLineCategories(t, v.lines);
      return previewRouting({ ...cell, requesterId: userId, amount: formatPaise(v.totalPaise), lines }, t);
    });
    return ok(res, out);
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * GET /v1/pr/:id/routing-preview — the routing a saved PR would get if
 * submitted now: its active lines and live total, with separation of duties
 * evaluated against its requester (not the viewer). Anyone who may read the
 * PR; everyone else gets 404.
 */
export async function savedRoutingPreview(req, res) {
  try {
    const id = posInt(req.params.id);
    const out = await db.task(async (t) => {
      const pr = id ? await prModel.getPrRow(id, t) : null;
      if (!pr || !(await canReadPr(req.user, pr, t))) throw notFound();
      const inputs = await prModel.routingInputs(id, t);
      if (!inputs) throw notFound();
      return previewRouting({ ...cellOf(pr), requesterId: Number(pr.raised_by), ...inputs }, t);
    });
    return ok(res, out);
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

// ---------------------------------------------------------------------------
// Buyer pool (Task 8, spec §9): the pool, the buyers picker, assignment,
// mapping, catalog requests, closing (buyer) and cancelling (requester) a
// line. Who may act is decided in prPool under the PR row lock; scope comes
// from req.user and the PR row only.
// ---------------------------------------------------------------------------
const POOL_DEFAULT_PAGE_SIZE = 50;
const POOL_MAX_PAGE_SIZE = 200;
const POOL_ASSIGNED = ['me', 'unassigned', 'any'];

/**
 * GET /v1/pr/pool?hotel_id=&department_id=&category_id=&progress=&assigned=me|unassigned|any&q=&page=&page_size=
 * Lines of approved PRs waiting for the purchase team, at the hotels where the
 * caller holds pr.convert (403 when there are none). `progress` is one value or
 * a comma-separated / repeated list of in_pool | needs_mapping | awaiting_catalog
 * (default: all three). Filters only ever narrow that scope.
 * → { rows, total, page, page_size, hotels: [{id, name}] } (hotels = the caller's pool hotels).
 */
export async function pool(req, res) {
  try {
    const hotels = await prModel.poolHotels(req.user.id);
    if (!hotels.length) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.convert'));

    const qs = req.query || {};
    const errors = [];
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const idFilter = (field) => {
      const raw = one(qs[field]);
      if (raw === undefined || raw === null || raw === '') return null;
      const n = posInt(raw);
      if (!n) errors.push({ field, message: `Invalid ${field}` });
      return n;
    };
    const rawProgress = (Array.isArray(qs.progress) ? qs.progress : [qs.progress]).filter((v) => v !== undefined);
    const progress = [...new Set(rawProgress
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : [null]))
      .map((v) => (v === null ? null : v.trim())).filter((v) => v !== ''))];
    if (progress.some((v) => !POOL_PROGRESSES.includes(v))) {
      errors.push({ field: 'progress', message: `progress must be among ${POOL_PROGRESSES.join(', ')}` });
    }
    const assigned = text(one(qs.assigned)) || 'any';
    if (!POOL_ASSIGNED.includes(assigned)) errors.push({ field: 'assigned', message: 'assigned must be me, unassigned or any' });
    const filters = {
      hotelId: idFilter('hotel_id'),
      departmentId: idFilter('department_id'),
      categoryId: idFilter('category_id'),
      progress,
      assigned,
      q: text(one(qs.q)).slice(0, 100),
      page: 1,
      pageSize: POOL_DEFAULT_PAGE_SIZE,
    };
    if (qs.page !== undefined && qs.page !== '') {
      const n = posInt(one(qs.page));
      if (!n) errors.push({ field: 'page', message: 'Invalid page' }); else filters.page = n;
    }
    if (qs.page_size !== undefined && qs.page_size !== '') {
      const n = posInt(one(qs.page_size));
      if (!n) errors.push({ field: 'page_size', message: 'Invalid page_size' });
      else filters.pageSize = Math.min(n, POOL_MAX_PAGE_SIZE);
    }
    if (errors.length) throw prError(PR_ERR.VALIDATION, 'Invalid query', errors);

    const { rows, total } = await prModel.pool(req.user.id, filters);
    return ok(res, { rows, total, page: filters.page, page_size: filters.pageSize, hotels });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/buyers?hotel_id= — the hotel's buyers [{id, name}], for a caller who works its pool. */
export async function buyers(req, res) {
  try {
    const hotelId = posInt(req.query.hotel_id);
    if (!hotelId) throw prError(PR_ERR.VALIDATION, 'Missing parameters', [{ field: 'hotel_id', message: 'hotel_id is required' }]);
    const hotel = await prModel.hotelCell(hotelId);
    if (!hotel) throw prError(PR_ERR.FORBIDDEN, forbiddenMessage('pr.convert'));
    const scope = { companyId: Number(hotel.hospitality_company_id), hotelId };
    await assertPerm(req.user.id, 'pr.convert', scope);
    return ok(res, await prModel.buyersForHotel(scope));
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/assign {buyer_id} — a buyer of the PR's hotel assigns an approved PR to one of its buyers. */
export async function assign(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await prPool.assign(id, req.user, req.body), 'Assigned');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/lines/:lineId/map {variant_id} — a buyer maps a free-text line to a catalog item. */
export async function mapLine(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await prPool.mapLine(id, posInt(req.params.lineId), req.user, req.body), 'Line mapped');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/lines/:lineId/catalog-request {requested_name?, description?} — a buyer asks for a catalog item. */
export async function catalogRequest(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await prPool.requestCatalogItem(id, posInt(req.params.lineId), req.user, req.body), 'Catalog item requested');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/lines/:lineId/close {reason} — a buyer closes a pool line. */
export async function closeLine(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await prPool.closeLine(id, posInt(req.params.lineId), req.user, req.body?.reason), 'Line closed');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** POST /v1/pr/:id/lines/:lineId/cancel {reason} — the requester cancels a line of their approved PR. */
export async function cancelLine(req, res) {
  try {
    const id = posInt(req.params.id);
    if (!id) throw notFound();
    return ok(res, await prPool.cancelLine(id, posInt(req.params.lineId), req.user, req.body?.reason), 'Line cancelled');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/**
 * POST /v1/pr/convert {line_ids, department_id, process_id?} — a buyer turns
 * approved pool lines of one hotel into ONE RFQ draft (prConversion), answered
 * after the commit with {rfq_id, rfq_no, redirect} (the wizard page that opens it).
 */
export async function convert(req, res) {
  try {
    return ok(res, await prConversion.convert(req.user, req.body), 'RFQ draft created');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}
