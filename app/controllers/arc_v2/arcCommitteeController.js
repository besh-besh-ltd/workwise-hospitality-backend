import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { logger } from '../../util/logger.js';
import { generateContractsForArc } from './arcContractController.js';
import { getApprovalInstanceDetails } from '../../models/generalModel.js';
import { executeApprovalAction } from '../../services/approvalActionService.js';

/**
 * ARC v2 — Committee approval controller.
 *
 * Committee approval rides on the existing approval engine
 * (entity_type='ARC_COMMITTEE'). The committee dashboard endpoint surfaces
 * the approval instance + per-member action history. Actual decision actions
 * go through the existing executeApprovalAction → submitApprovalAction
 * pipeline, which dispatches to handleArcCommitteeApproval / Rejection below
 * once the instance reaches APPROVED / REJECTED.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }

export async function getCommitteeView(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    const comm = await arcEvalModel.getCommEval(arcId);
    const awards = comm ? await arcEvalModel.listAwards(comm.id) : [];
    const items  = await arcModel.listItems(arcId);
    // Human-readable scope for the hero (getById is a bare SELECT *).
    const ctx = await db.oneOrNone(
      `SELECT cat.title AS category_title, h.name AS hotel_name,
              d.title AS department_title, u.name AS created_by_name
         FROM tbl_arc a
         LEFT JOIN tbl_category cat ON cat.id = a.category_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN tbl_department d ON d.id = a.department_id
         LEFT JOIN tbl_users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [arcId]
    );
    // Approval instance for ARC_COMMITTEE (if any) + the full step/approver
    // detail so the page can render exactly who has acted, who is next, and
    // whether the CALLER is the current approver (can_user_approve).
    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    let approval = null;
    if (instance) {
      try {
        approval = await getApprovalInstanceDetails(instance.id, req.user?.id || null);
      } catch (detailErr) {
        logger.warn({ detailErr, instanceId: instance.id },
          '[committeeController.getCommitteeView] instance detail load failed');
      }
    }
    return ok(res, {
      arc: { ...arc, ...(ctx || {}) },
      comm_evaluation: comm, awards, items,
      approval_instance: instance,
      approval,
    });
  } catch (err) {
    logger.error({ err }, '[committeeController.getCommitteeView]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// POST /v1/arc-v2/committee/:arcId/decide
//   Body: { decision: 'approve' | 'reject', comment? }
//   Funnels through executeApprovalAction so the engine validates the
//   caller is the CURRENT pending approver and the post-approval hooks
//   (contract generation / send-back) fire on the terminal transition.
//   A rejection is a committee send-back, so a reason is mandatory.
// ============================================================
export async function decideCommittee(req, res) {
  try {
    const arcId   = Number(req.params.arcId);
    const userId  = req.user?.id;
    const decision = String(req.body?.decision || '').trim();
    const comment  = req.body?.comment ? String(req.body.comment) : null;

    if (!arcId)  return bad(res, 400, 'arcId is required');
    if (!userId) return bad(res, 401, 'Authentication required');
    if (decision !== 'approve' && decision !== 'reject') {
      return bad(res, 400, "decision must be 'approve' or 'reject'");
    }
    if (decision === 'reject' && !comment) {
      return bad(res, 400, 'A reason (comment) is required when sending back');
    }

    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (!instance) return bad(res, 404, 'No committee approval instance for this ARC', 2);
    if (instance.status !== 'PENDING') {
      return bad(res, 400, `Committee decision is already ${instance.status} — no further actions allowed`);
    }

    const result = await executeApprovalAction({
      approval_instance_id: instance.id,
      approver_user_id:     userId,
      action:               decision.toUpperCase(),
      comment,
    });
    const approval = await getApprovalInstanceDetails(instance.id, userId).catch(() => null);
    return ok(res, { result, approval });
  } catch (err) {
    logger.error({ err }, '[committeeController.decideCommittee]');
    const msg = err.message || 'Internal error';
    const code = /not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step/i.test(msg) ? 400 : 500;
    return bad(res, code, msg, code === 500 ? 3 : 0);
  }
}

/**
 * Post-approval hook: committee approved → trigger contract generation.
 *   options.instance carries { entity_id: arc_id, ... }
 */
export async function handleArcCommitteeApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const arcId = instance?.entity_id;
    if (!arcId) return;
    await db.tx(async (t) => {
      await arcModel.setStatus(arcId, 'committee_approved', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMMITTEE_DECISION,
        actorId: approverUserId, payload: { decision: 'approved', approval_instance_id: approvalInstanceId },
        txContext: t,
      });
      // Generate one contract per awarded vendor.
      const contracts = await generateContractsForArc(arcId, { txContext: t, generatedBy: approverUserId });
      await arcModel.setStatus(arcId, 'awaiting_vendor_acceptance', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.CONTRACT_GENERATED,
        actorId: approverUserId, payload: { contract_count: contracts.length },
        txContext: t,
      });
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[committeeController.handleArcCommitteeApproval]');
  }
}

export async function handleArcCommitteeRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const instance = options.instance;
    const arcId = instance?.entity_id;
    const reason = options.comment || '';
    if (!arcId) return;
    await db.tx(async (t) => {
      // Decision: send back to commercial eval for re-reconciliation.
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (comm) await arcEvalModel.setCommEvalStatus(comm.id, 'sent_back', {}, t);
      await arcModel.setStatus(arcId, 'committee_sent_back', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMMITTEE_DECISION,
        actorId: approverUserId, payload: { decision: 'rejected', reason, approval_instance_id: approvalInstanceId },
        txContext: t,
      });
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[committeeController.handleArcCommitteeRejection]');
  }
}
