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
import { hasPerm, assertPerm, canReadPr } from '../../services/pr/prAccess.js';
import { describeVariants, contractCoverage } from '../../services/pr/prCatalog.js';

const ok = (res, data, message = 'success') => res.status(200).json({ status: 1, message, data });

const PR_TYPES = ['goods', 'service', 'capex'];
const URGENCIES = ['low', 'normal', 'urgent'];
export const EDITABLE_STATUSES = ['draft', 'returned'];
export const WITHDRAWABLE_STATUSES = ['in_review', 'pending_approval'];
const MAX_LINES = 200;
const QTY_RE = /^\d{1,15}(\.\d{1,3})?$/;            // NUMERIC(18,3)
const PRICE_RE = /^\d{1,16}(\.\d{1,2})?$/;          // NUMERIC(18,2)
const PRICE_MAX_INT_DIGITS = 14;                    // ≤ 99,999,999,999,999.99
const TOTAL_MAX_PAISE = 999999999999999999n;        // Σ must fit estimated_total NUMERIC(18,2)
const MAX_LEN = {
  title: 200, justification: 4000, delivery_location: 1000, free_text_name: 300, uom: 50,
  specification: 20000, suggested_vendor_note: 2000, reason: 2000,
};
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
const notFound = () => prError(PR_ERR.NOT_FOUND, 'Purchase requisition not found');
const cellOf = (pr) => ({
  companyId: Number(pr.hospitality_company_id), hotelId: Number(pr.hotel_id), departmentId: Number(pr.department_id),
});
const isRequester = (user, pr) => Number(pr.raised_by) === Number(user?.id);

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
    b.lines.forEach((raw, i) => {
      const line_no = i + 1;
      const r = raw && typeof raw === 'object' ? raw : {};
      const lerr = (field, message) => err(field, message, { line_no });

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

      const quantity = decimalText(r.quantity);
      const qtyOk = quantity != null && QTY_RE.test(quantity) && hasNonZeroDigit(quantity);
      if (!qtyOk) lerr('quantity', 'Quantity must be a positive number with at most 3 decimals');

      const price = decimalText(r.estimated_unit_price);
      const priceOk = price != null && PRICE_RE.test(price) && hasNonZeroDigit(price)
        && price.split('.')[0].replace(/^0+/, '').length <= PRICE_MAX_INT_DIGITS;
      if (!priceOk) {
        lerr('estimated_unit_price', 'Estimated unit price must be a positive amount with at most 2 decimals (max 99,999,999,999,999.99)');
      }

      const uom = text(r.uom);
      if (!uom) lerr('uom', 'Unit is required');
      else if (uom.length > MAX_LEN.uom) lerr('uom', `Must be at most ${MAX_LEN.uom} characters`);

      const specification = text(r.specification) || null;
      if (specification && specification.length > MAX_LEN.specification) lerr('specification', `Must be at most ${MAX_LEN.specification} characters`);
      const suggested_vendor_note = text(r.suggested_vendor_note) || null;
      if (suggested_vendor_note && suggested_vendor_note.length > MAX_LEN.suggested_vendor_note) {
        lerr('suggested_vendor_note', `Must be at most ${MAX_LEN.suggested_vendor_note} characters`);
      }

      // Line value = ROUND(qty × price, 2): qty has 3 decimals, price 2 → 5;
      // half-up back to paise (values are positive, so this equals Postgres ROUND).
      if (qtyOk && priceOk) totalPaise += (toScaled(quantity, 3) * toScaled(price, 2) + 500n) / 1000n;

      lines.push({
        line_no, line_kind, product_variant_id, category_id,
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
 * Catalog guards for validated lines, in severity order (each code lists every
 * offending line): unknown variant/category → PR_VALIDATION; variant the RFQ
 * wizard would refuse → PR_VARIANT_NOT_USABLE; variant on a live rate contract
 * for the cell → PR_LINE_ON_CONTRACT. Returns the lines with each catalog
 * line's category_id derived from its product.
 */
async function resolveCatalogLines(t, cell, lines) {
  const catalog = lines.filter((l) => l.line_kind === 'catalog');
  const freeText = lines.filter((l) => l.line_kind === 'free_text');
  const variants = await describeVariants(catalog.map((l) => l.product_variant_id), t);
  const categories = await prModel.activeCategoryIds(freeText.map((l) => l.category_id), t);

  const unknown = [
    ...catalog.filter((l) => !variants.has(l.product_variant_id))
      .map((l) => ({ field: 'product_variant_id', line_no: l.line_no, message: 'This catalog item does not exist' })),
    ...freeText.filter((l) => !categories.has(l.category_id))
      .map((l) => ({ field: 'category_id', line_no: l.line_no, message: 'This category does not exist or is inactive' })),
  ].sort((a, b) => a.line_no - b.line_no);
  if (unknown.length) throw prError(PR_ERR.VALIDATION, 'Some lines reference items or categories that do not exist', unknown);

  const unusable = catalog
    .filter((l) => !variants.get(l.product_variant_id).usable || variants.get(l.product_variant_id).category_id == null)
    .map((l) => {
      const v = variants.get(l.product_variant_id);
      return { line_no: l.line_no, product_variant_id: l.product_variant_id, variant_name: v.name, reason: v.usable ? 'no_category' : 'not_usable' };
    });
  if (unusable.length) throw prError(PR_ERR.VARIANT_NOT_USABLE, 'Some catalog items can no longer be requested', unusable);

  const coverage = await contractCoverage({
    hotelId: cell.hotelId, departmentId: cell.departmentId, variantIds: catalog.map((l) => l.product_variant_id),
  }, t);
  const onContract = catalog.filter((l) => coverage.has(l.product_variant_id)).map((l) => ({
    line_no: l.line_no,
    product_variant_id: l.product_variant_id,
    variant_name: variants.get(l.product_variant_id).name,
    ...coverage.get(l.product_variant_id),
  }));
  if (onContract.length) {
    throw prError(PR_ERR.LINE_ON_CONTRACT, 'These items are on a rate contract for this hotel and department — raise an MR instead', onContract);
  }

  return lines.map((l) => (l.line_kind === 'catalog' ? { ...l, category_id: variants.get(l.product_variant_id).category_id } : l));
}

/**
 * Shared by create and update: validate, authorize the chosen cell with
 * pr.create, then run the catalog guards. Authorization precedes field errors
 * so a caller without access learns nothing about the payload's validity.
 */
async function prepareDraft(t, userId, body) {
  const v = validateDraftBody(body, { istToday: await prModel.istToday(t) });
  if (v.errors.some((e) => e.field === 'hotel_id' || e.field === 'department_id')) {
    throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', v.errors);
  }
  const hotel = await prModel.hotelCell(v.header.hotel_id, t);
  if (!hotel) {
    throw prError(PR_ERR.FORBIDDEN, 'You do not have access to raise purchase requisitions for this hotel/department');
  }
  const cell = {
    companyId: Number(hotel.hospitality_company_id), hotelId: v.header.hotel_id, departmentId: v.header.department_id,
  };
  await assertPerm(userId, 'pr.create', cell, t);
  if (v.errors.length) throw prError(PR_ERR.VALIDATION, 'Please fix the highlighted fields', v.errors);
  if (!(await prModel.departmentExists(cell.departmentId, t))) {
    throw prError(PR_ERR.VALIDATION, 'Unknown department', [{ field: 'department_id', message: 'Unknown department' }]);
  }
  const lines = await resolveCatalogLines(t, cell, v.lines);
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

/** Booleans the FE renders actions from. Later tasks add review/approve/convert keys. */
async function capabilitiesFor(user, pr) {
  const requester = isRequester(user, pr);
  const mayCreate = requester && (await hasPerm(user.id, 'pr.create', cellOf(pr)));
  const editable = EDITABLE_STATUSES.includes(pr.status);
  return {
    can_edit: mayCreate && editable,
    can_submit: mayCreate && editable,
    can_withdraw: requester && WITHDRAWABLE_STATUSES.includes(pr.status),
    can_cancel: requester && editable,
    can_copy: mayCreate,
  };
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

/** PUT /v1/pr/:id — replace a draft/returned PR (header + every line). Requester only. */
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
      const { cell, header, lines } = await prepareDraft(t, userId, body);

      const patch = headerRow(cell, header);
      const before = await t.one(`SELECT COUNT(*)::int AS c FROM tbl_purchase_requisition_line WHERE pr_id = $1`, [id]);
      await prModel.updateHeader(t, id, patch);
      await prModel.replaceLines(t, id, lines);
      await record(t, {
        prId: id, revision: pr.revision, actorId: userId, type: 'updated',
        payload: { changed: headerDiff(pr, patch), lines: { before: before.c, after: lines.length } },
      });
      return { id, pr_number: pr.pr_number };
    });
    return ok(res, out, 'Purchase requisition updated');
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

/** GET /v1/pr/:id — detail + capabilities, for anyone who may read the PR (else 404). */
export async function getById(req, res) {
  try {
    const id = posInt(req.params.id);
    const pr = id ? await prModel.getPrRow(id) : null;
    if (!pr || !(await canReadPr(req.user, pr))) throw notFound();
    const detail = await prModel.getDetail(id);
    if (!detail) throw notFound();
    return ok(res, { ...detail, capabilities: await capabilitiesFor(req.user, pr) });
  } catch (err) {
    return sendPrError(res, err, logger);
  }
}

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
  if (!hotel) throw prError(PR_ERR.FORBIDDEN, 'You do not have access to this hotel/department');
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
 * GET /v1/pr/search-items?hotel_id=&department_id=&q= — usable catalog
 * variants for the line picker, flagged when on a rate contract for the cell
 * (the FE blocks those with "raise an MR instead"; save refuses them too).
 */
export async function searchItems(req, res) {
  try {
    const cell = await authorizeCreateCell(req, { requireDepartment: true });
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
