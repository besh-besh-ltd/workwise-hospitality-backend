import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';

/**
 * ARC v2 — Tech + Commercial evaluation controller.
 *
 * Tech-eval endpoints set up clauses, capture vendor responses, score, and
 * route through the approval engine (entity_type='ARC_TECH'). Comm-eval
 * endpoints surface qualified-vendor quotes, manage the split-award
 * reconciliation (plan §4.4 invariant), and finalise to route through
 * ARC_COMMITTEE.
 *
 * Post-approval hooks at the bottom are registered in approvalActionService.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

// ============================================================
// TECH EVAL endpoints
// ============================================================

export async function setupTechEval(req, res) {
  try {
    const arcItemId = Number(req.params.itemId);
    const { minimum_passing_score, clauses = [] } = req.body || {};
    return db.tx(async (t) => {
      const te = await arcEvalModel.upsertTechEval(arcItemId, { minimum_passing_score }, t);
      const inserted = [];
      for (const c of clauses) {
        inserted.push(await arcEvalModel.addClause(te.id, c, t));
      }
      return ok(res, { tech_evaluation: te, clauses: inserted });
    });
  } catch (err) {
    logger.error({ err }, '[evalController.setupTechEval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function recordVendorResponse(req, res) {
  try {
    const { clause_id, vendor_id, response } = req.body || {};
    if (!clause_id || !vendor_id) return bad(res, 400, 'clause_id and vendor_id are required');
    const row = await arcEvalModel.upsertVendorResponse(clause_id, vendor_id, response || null);
    return ok(res, { response: row });
  } catch (err) {
    logger.error({ err }, '[evalController.recordVendorResponse]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function scoreResponse(req, res) {
  try {
    const userId = req.user?.id;
    const { response_id, buyer_marks, buyer_remark } = req.body || {};
    if (!response_id || buyer_marks == null) return bad(res, 400, 'response_id and buyer_marks are required');
    const row = await arcEvalModel.scoreVendorResponse(response_id, {
      buyer_id: userId, buyer_marks, buyer_remark,
    });
    return ok(res, { response: row });
  } catch (err) {
    logger.error({ err }, '[evalController.scoreResponse]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getTechEvalForItem(req, res) {
  try {
    const arcItemId = Number(req.params.itemId);
    const te = await db.oneOrNone(`SELECT * FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`, [arcItemId]);
    if (!te) return ok(res, { tech_evaluation: null });
    const clauses = await arcEvalModel.listClauses(te.id);
    const scores = await arcEvalModel.computeItemScores(arcItemId);
    return ok(res, { tech_evaluation: te, clauses, scores });
  } catch (err) {
    logger.error({ err }, '[evalController.getTechEvalForItem]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function submitTechEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    return db.tx(async (t) => {
      const items = await arcModel.listItems(arcId, t);
      for (const item of items) {
        const scores = await arcEvalModel.computeItemScores(item.id, 1, t);
        const te = await db.oneOrNone(
          `SELECT id FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`, [item.id]
        );
        if (te && scores.length > 0) {
          await arcEvalModel.recordClearedVendors(
            te.id,
            scores.map(s => ({ ...s, created_by: userId, evaluation_round: 1 })),
            t
          );
        }
      }
      await arcModel.setStatus(arcId, 'tech_eval_in_progress', {}, t);
      await logArcEvent({ arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_SUBMITTED, actorId: userId, payload: {}, txContext: t });
      return ok(res, { ok: true });
    });
  } catch (err) {
    logger.error({ err }, '[evalController.submitTechEval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// COMMERCIAL EVAL endpoints
// ============================================================

export async function getCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const items = await arcModel.listItems(arcId);
    const quotes = await arcEvalModel.listAllQuotesForArc(arcId);
    const comm = await arcEvalModel.getCommEval(arcId);
    const awards = comm ? await arcEvalModel.listAwards(comm.id) : [];
    return ok(res, { comm_evaluation: comm, items, quotes, awards });
  } catch (err) {
    logger.error({ err }, '[evalController.getCommEval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

/**
 * Save a new allocation for an item. Body shape:
 *   { item_id, allocations: [{ awarded_vendor_id, awarded_quote_line_id, allocated_qty, l_rank, is_l1_default, awarded_quote_snapshot }] }
 *
 * Enforces the reconciliation invariant: SUM(allocated_qty) for the item must
 * equal tbl_arc_item.indicative_qty.
 */
export async function saveAllocation(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    const { item_id, allocations } = req.body || {};
    if (!item_id || !Array.isArray(allocations)) {
      return bad(res, 400, 'item_id and allocations[] are required');
    }
    return db.tx(async (t) => {
      const item = await t.oneOrNone(`SELECT * FROM tbl_arc_item WHERE id = $1 AND arc_id = $2`, [item_id, arcId]);
      if (!item) return bad(res, 404, 'item not found', 2);
      const sum = allocations.reduce((s, a) => s + Number(a.allocated_qty || 0), 0);
      const target = Number(item.indicative_qty);
      if (Math.abs(sum - target) > 1e-6) {
        return bad(res, 400, `Allocations sum (${sum}) must equal indicative_qty (${target})`);
      }
      const comm = await arcEvalModel.upsertCommEval(arcId, t);
      const inserted = await arcEvalModel.setItemAwards(comm.id, item_id, allocations, t);
      await arcEvalModel.appendCommEvalHistory(comm.id, 'allocation_saved', { item_id, allocations }, userId, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_ALLOCATION_UPDATED,
        actorId: userId, payload: { item_id, vendor_count: allocations.length }, txContext: t,
      });
      return ok(res, { comm_evaluation: comm, awards: inserted });
    });
  } catch (err) {
    logger.error({ err }, '[evalController.saveAllocation]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function finalizeCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    return db.tx(async (t) => {
      const arc = await arcModel.getById(arcId, t);
      if (!arc) return bad(res, 404, 'ARC not found', 2);
      const items = await arcModel.listItems(arcId, t);
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (!comm) return bad(res, 400, 'Commercial evaluation has not been started');
      // Validate every item has allocations that sum to indicative_qty.
      const awards = await arcEvalModel.listAwards(comm.id, t);
      const byItem = new Map();
      for (const a of awards) {
        const key = String(a.arc_item_id);
        byItem.set(key, (byItem.get(key) || 0) + Number(a.allocated_qty));
      }
      const itemsMissing = [];
      for (const item of items) {
        const got = byItem.get(String(item.id)) || 0;
        if (Math.abs(got - Number(item.indicative_qty)) > 1e-6) {
          itemsMissing.push({ item_id: item.id, indicative_qty: item.indicative_qty, allocated: got });
        }
      }
      if (itemsMissing.length > 0) {
        return bad(res, 400, `Allocation incomplete for ${itemsMissing.length} item(s)`);
      }
      const updated = await arcEvalModel.setCommEvalStatus(comm.id, 'finalized', {
        finalized_by: userId,
        finalized_at: new Date(),
      }, t);
      await arcModel.setStatus(arcId, 'committee_review', {}, t);
      await arcEvalModel.appendCommEvalHistory(comm.id, 'finalized', { item_count: items.length }, userId, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_FINALIZED,
        actorId: userId, payload: { item_count: items.length }, txContext: t,
      });
      return ok(res, { comm_evaluation: updated }, 'Commercial evaluation finalized');
    });
  } catch (err) {
    logger.error({ err }, '[evalController.finalizeCommEval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function sendBackCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    const reason = req.body?.reason;
    return db.tx(async (t) => {
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (!comm) return bad(res, 404, 'comm eval not found', 2);
      const updated = await arcEvalModel.setCommEvalStatus(comm.id, 'sent_back', {}, t);
      await arcModel.setStatus(arcId, 'comm_eval_in_progress', {}, t);
      await arcEvalModel.appendCommEvalHistory(comm.id, 'sent_back', { reason }, userId, t);
      await logArcEvent({ arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_SENT_BACK, actorId: userId, payload: { reason }, txContext: t });
      return ok(res, { comm_evaluation: updated }, 'Sent back');
    });
  } catch (err) {
    logger.error({ err }, '[evalController.sendBackCommEval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Post-approval hooks (registered in approvalActionService)
// ============================================================

export async function handleArcTechPostApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const arcId = instance?.entity_id;
    if (!arcId) return;
    await db.tx(async (t) => {
      await arcModel.setStatus(arcId, 'tech_eval_approved', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_APPROVED,
        actorId: approverUserId, payload: { approval_instance_id: approvalInstanceId },
        txContext: t,
      });
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[evalController.handleArcTechPostApproval]');
  }
}

export async function handleArcTechRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const arcId = instance?.entity_id;
    if (!arcId) return;
    await db.tx(async (t) => {
      await arcModel.setStatus(arcId, 'tech_eval_rejected', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_REJECTED,
        actorId: approverUserId, payload: { approval_instance_id: approvalInstanceId },
        txContext: t,
      });
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[evalController.handleArcTechRejection]');
  }
}
