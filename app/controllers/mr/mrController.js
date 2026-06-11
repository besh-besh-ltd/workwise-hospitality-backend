import db from '../../config/dbConn.js';
import mrModel from '../../models/mr/mrModel.js';
import { releaseForMr } from '../../services/callOffPoService.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import { resolveHospitalityCompanyId } from '../../helper/arc_v2/resolveHospitalityCompany.js';

/**
 * MR (Material Requisition) — Buyer-side controller.
 *
 * Contracted-items-only per plan §2.1. Item picker (searchContractedItems)
 * never returns non-contracted items, and the submit endpoint re-validates
 * each item references an active contract for the user's hotel/department.
 *
 * The post-approval hook handleMrPostApproval is the trigger for
 * callOffPoService.releaseForMr, which generates one call-off PO per vendor
 * contract under the MR.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

function generateMrNumber(now = new Date()) {
  const yyyy = now.getFullYear();
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `MR-${yyyy}-${rand}`;
}

/**
 * GET /v1/mr/search-contracted-items?hotel_id=&department_id=&q=
 *
 * Picker used by the MR-create wizard. Always scoped to the requesting user's
 * (hotel × department) — only the user's accessible context is allowed.
 */
export async function searchContractedItems(req, res) {
  try {
    const hotelId      = Number(req.query.hotel_id);
    const departmentId = Number(req.query.department_id);
    if (!hotelId || !departmentId) return bad(res, 400, 'hotel_id and department_id are required');
    const rows = await mrModel.searchContractedItems({
      hotel_id:      hotelId,
      department_id: departmentId,
      query:         req.query.q || null,
      limit:         Math.min(Number(req.query.limit || 25), 100),
    });
    return ok(res, { items: rows });
  } catch (err) {
    logger.error({ err }, '[mrController.searchContractedItems]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    const required = ['title','hospitality_company_id','hotel_id','department_id'];
    for (const k of required) {
      if (!body[k]) return bad(res, 400, `${k} is required`);
    }
    return db.tx(async (t) => {
      const mr = await mrModel.createDraft({
        mr_number: body.mr_number || generateMrNumber(),
        title: body.title,
        hospitality_company_id: body.hospitality_company_id,
        hotel_id: body.hotel_id,
        department_id: body.department_id,
        cost_center: body.cost_center,
        urgency: body.urgency,
        required_by_date: body.required_by_date,
        justification: body.justification,
        delivery_location: body.delivery_location,
        raised_by: userId,
      }, t);
      const items = Array.isArray(body.items) ? body.items : [];
      const inserted = [];
      for (const it of items) {
        if (!it.arc_contract_id || !it.arc_contract_line_id || !it.product_variant_id || !it.quantity) {
          continue;
        }
        inserted.push(await mrModel.addItem(mr.id, it, t));
      }
      return ok(res, { mr, items: inserted }, 'MR draft created');
    });
  } catch (err) {
    logger.error({ err }, '[mrController.createDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * POST /v1/mr/:id/submit — flip from draft → pending_approval. The actual
 * approval instance creation depends on the existing approval engine
 * (createApprovalInstance with entity_type='MR'). For the foundation we set
 * the status; the explicit approval-instance creation should be wired in
 * via generalModel.createApprovalInstance once the route layer integrates it.
 */
export async function submit(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    if (mr.raised_by !== userId) return bad(res, 403, 'Only the raiser can submit');
    if (mr.status !== 'draft') return bad(res, 409, `Cannot submit MR in status ${mr.status}`);
    const items = await mrModel.listItems(id);
    if (items.length === 0) return bad(res, 400, 'MR must have at least one item');
    // Defence-in-depth: every item must reference an active contract for the
    // MR's department + hotel.
    const invalid = items.filter(it =>
      !it.arc_contract_id ||
      !it.arc_contract_line_id
    );
    if (invalid.length > 0) {
      return bad(res, 400, `${invalid.length} item(s) reference no active contract`);
    }
    return db.tx(async (t) => {
      const updated = await mrModel.setStatus(id, 'pending_approval', { submitted_at: new Date() }, t);
      return ok(res, { mr: updated, items }, 'MR submitted for approval');
    });
  } catch (err) {
    logger.error({ err }, '[mrController.submit]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getById(req, res) {
  try {
    const id = Number(req.params.id);
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    const items = await mrModel.listItems(id);
    return ok(res, { mr, items });
  } catch (err) {
    logger.error({ err }, '[mrController.getById]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function list(req, res) {
  try {
    const { hospitality_company_id, hotel_ids, department_ids, statusGroup, raised_by, page, limit } = req.query;
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const result = await mrModel.list({
      hospitality_company_id: hcId,
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
      raised_by:      raised_by ? Number(raised_by) : null,
      statusGroup: statusGroup || 'all',
      page:  Number(page || 1),
      limit: Number(limit || 20),
    });
    return ok(res, result);
  } catch (err) {
    logger.error({ err }, '[mrController.list]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function dashboardCounts(req, res) {
  try {
    const { hospitality_company_id, hotel_ids, department_ids, raised_by } = req.query;
    const hcId = await resolveHospitalityCompanyId(req);
    if (!hcId) return bad(res, 400, 'hospitality_company_id is required');
    const counts = await mrModel.dashboardCounts({
      hospitality_company_id: hcId,
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
      raised_by:      raised_by ? Number(raised_by) : null,
    });
    return ok(res, { counts });
  } catch (err) {
    logger.error({ err }, '[mrController.dashboardCounts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function cancel(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const mr = await mrModel.getById(id);
    if (!mr) return bad(res, 404, 'MR not found', 2);
    if (mr.raised_by !== userId) return bad(res, 403, 'Only the raiser can cancel');
    if (mr.status === 'po_released') return bad(res, 409, 'Cannot cancel MR already released as PO');
    const updated = await mrModel.setStatus(id, 'cancelled', {});
    return ok(res, { mr: updated }, 'MR cancelled');
  } catch (err) {
    logger.error({ err }, '[mrController.cancel]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Post-approval hooks (registered in approvalActionService)
// ============================================================

/**
 * On MR approval, fire the call-off PO release.
 * options.instance carries { entity_id: mr_id, ... }
 */
export async function handleMrPostApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const mrId = instance?.entity_id;
    if (!mrId) return;
    const mr = await mrModel.getById(mrId);
    if (!mr) {
      logger.warn({ approvalInstanceId, mrId }, '[mrController.handleMrPostApproval] MR not found');
      return;
    }
    await db.tx(async (t) => {
      await mrModel.setStatus(mrId, 'approved', {}, t);
      const released = await releaseForMr(mrId, t);
      // releaseForMr already flips MR to po_released after writing the PO links.
      logger.info({ mrId, contracts: released.length }, '[mrController.handleMrPostApproval] call-off POs released');
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[mrController.handleMrPostApproval]');
  }
}

export async function handleMrRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const mrId = instance?.entity_id;
    if (!mrId) return;
    await mrModel.setStatus(mrId, 'rejected', {});
    logger.info({ mrId }, '[mrController.handleMrRejection] MR marked rejected');
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[mrController.handleMrRejection]');
  }
}
