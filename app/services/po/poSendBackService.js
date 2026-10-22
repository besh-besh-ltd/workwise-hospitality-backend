// Putting a PO on hold to ask a named person for information (client ticket T3).
//
// An approver on the PO's current step asks someone a question: the RFQ
// creator, the PO's creator, the commercial or the technical evaluator. The
// PO is then "on hold": an OPEN row in tbl_po_send_backs, route INFO_REQUEST.
// Nothing else changes. The approval instance stays PENDING at the same step,
// no step or approver status moves, and no PO status is involved. While the
// row is open nobody on that step can approve or reject (poHold.js). The
// person asked answers, or any pending approver on the step (or whoever asked)
// withdraws it, and the step carries on where it was.
//
// RULES
//   - Who is asked is resolved here from the RFQ and the PO, never taken from
//     the request (resolveTargets).
//   - Every write takes the PO row FOR UPDATE, then the PO's approval
//     instance FOR UPDATE, then the send-back row (lockPo / the instance, as
//     every PO decision does). One transaction per change.
//   - Notifications go out after COMMIT and never throw (poSendBackNotifier).
//   - Vendors never reach any of this: every route is noAcl([3]).
//
// The rejection routes (COMMERCIAL, CANCEL) are written by
// poApprovalService.executePoRejectionAtomically as CLOSED rows; the thread
// (listSendBacks) shows them together with the information requests.

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import db from '../../config/dbConn.js';
import s3Client from '../../config/s3config.js';
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';
import {
  assertPoAccess,
  isAssignedPoApprover,
  resolvePoTenancy,
  PoAccessError,
} from '../../models/purchaseOrderModel.js';
import { lockPo, lockCurrentPoInstance } from '../poApprovalService.js';
import { notifyApprovalChanged } from '../approvalEvents.js';
import { PoDecisionError } from './poDecisionError.js';
import { assertPoNotOnHold, findOpenHold, poOnHoldError } from './poHold.js';
import { REASON_CODES } from './poSendBackReasons.js';
import { signedFileUrl } from './s3SignedUrl.js';
import {
  notifySendBackRequested,
  notifySendBackAnswered,
  notifySendBackWithdrawn,
} from './poSendBackNotifier.js';

/** Who can be asked, in the order the dialog lists them. */
export const TARGET_ROLES = Object.freeze(['RFQ_CREATOR', 'PO_INITIATOR', 'COMMERCIAL_EVALUATOR', 'TECHNICAL_EVALUATOR']);

/** Reasons that are rejections, not questions: they go through Reject. */
const REJECTION_ONLY_REASONS = Object.freeze(['RENEGOTIATE', 'NOT_REQUIRED']);
export const INFO_REASONS = Object.freeze(REASON_CODES.filter((c) => !REJECTION_ONLY_REASONS.includes(c)));

const NOBODY_REASON = Object.freeze({
  RFQ_CREATOR: 'No RFQ creator is recorded for this purchase order.',
  PO_INITIATOR: 'No PO creator is recorded for this purchase order.',
  COMMERCIAL_EVALUATOR: 'No approved commercial evaluation was found for this purchase order.',
  TECHNICAL_EVALUATOR: 'No approved technical evaluation was found for this RFQ.',
});

// ── Errors ────────────────────────────────────────────────────────────────

const refuse = (message, code, httpStatus) => new PoDecisionError(message, { code, httpStatus });

const stepNotPending = () => refuse(
  'Only an approver who has not yet decided at the current level can ask for information. Refresh to see where it stands.',
  'STEP_NOT_PENDING', 409
);
const holdNotOpen = (status) => refuse(
  `This request for information is already ${String(status || 'closed').toLowerCase()}. Refresh to see where it stands.`,
  'HOLD_NOT_OPEN', 409
);
const notAllowed = () => refuse(
  'Only the approver who asked, or an approver still to decide at that level, can withdraw this request.',
  'NOT_ALLOWED', 403
);

// ── Access ────────────────────────────────────────────────────────────────

/**
 * The PO's tenancy row when the caller may act on it as an approver would:
 * read scope on the PO, or an approver assignment on its approval (the same
 * gate POST /po/approve uses). Throws PoAccessError (404) otherwise.
 */
export async function assertApproverSideAccess(user, poId) {
  try {
    return await assertPoAccess(user, poId);
  } catch (err) {
    if (!(err instanceof PoAccessError)) throw err;
    if (!(await isAssignedPoApprover(user?.id, poId))) throw err;
    const po = await resolvePoTenancy(poId);
    if (!po) throw err;
    return po;
  }
}

/**
 * The current PENDING step of a PENDING instance on which `userId` is still a
 * PENDING approver, or null.
 */
async function pendingStepOf(conn, instanceId, userId) {
  return conn.oneOrNone(
    `SELECT st.id, st.step_order
       FROM tbl_approval_instances ai
       JOIN tbl_approval_instance_steps st
         ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = st.id
      WHERE ai.id = $1
        AND ai.status = 'PENDING'
        AND st.status = 'PENDING'
        AND sa.approver_user_id = $2
        AND sa.status = 'PENDING'
        AND sa.removed_at IS NULL
      LIMIT 1`,
    [instanceId, userId]
  );
}

/**
 * Before any upload: may this caller ask for information on this PO right
 * now? 404 out of scope, 400 call-off, 409 STEP_NOT_PENDING, and, when
 * `forCreate`, 409 PO_ON_HOLD. Read without locks; createInfoRequest checks
 * all of it again under them.
 */
export async function precheckAsker(user, poId, { forCreate = false } = {}) {
  const tenancy = await assertApproverSideAccess(user, poId);
  if (tenancy.is_call_off) {
    throw refuse('Information requests are not available on call-off purchase orders.', 'CALL_OFF_NOT_SUPPORTED', 400);
  }
  const po = await db.one(
    `SELECT id, status::text AS status, approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
  if (!po.approval_instance_id || po.status !== 'pending_approval') throw stepNotPending();
  if (!(await pendingStepOf(db, po.approval_instance_id, user.id))) throw stepNotPending();
  if (forCreate) {
    const hold = await findOpenHold(db, po.id);
    if (hold) throw poOnHoldError(hold);
  }
  return tenancy;
}

/**
 * Before any upload: the send-back the caller is answering. Only the person
 * asked, while they can still see the PO; anyone else gets 404, as if it did
 * not exist. 409 HOLD_NOT_OPEN once it is closed.
 */
export async function precheckResponder(user, sendBackId) {
  const sb = await db.oneOrNone(
    `SELECT id, purchase_order_id, target_user_id, status, route FROM tbl_po_send_backs WHERE id = $1`,
    [sendBackId]
  );
  if (!sb || sb.route !== 'INFO_REQUEST' || Number(sb.target_user_id) !== Number(user.id)) throw new PoAccessError();
  await assertPoAccess(user, sb.purchase_order_id);
  if (sb.status !== 'OPEN') throw holdNotOpen(sb.status);
  return sb;
}

// ── Who can be asked ──────────────────────────────────────────────────────

/**
 * The four people an approver can ask about this PO, resolved from the RFQ
 * and the PO, each available or not (with a reason):
 *   RFQ_CREATOR          tbl_rfq.created_by
 *   PO_INITIATOR         the PO's creator (tbl_rfq_purchase_order.initiated_by)
 *   COMMERCIAL_EVALUATOR whoever raised the latest APPROVED award approval
 *                        (NEGOTIATION_QUOTE) for the PO's products, else
 *                        whoever finalized the award (finalization history)
 *   TECHNICAL_EVALUATOR  whoever raised the latest APPROVED technical
 *                        approval for the RFQ
 * Not available: an inactive or deleted account, someone who cannot see the
 * PO (assertPoAccess), and the caller.
 */
export async function resolveTargets(conn, poId, callerId) {
  const ids = await conn.one(
    `WITH po AS (
       SELECT id, rfq_id, initiated_by, finalized_vendor_id, rfq_product_id
         FROM tbl_rfq_purchase_order WHERE id = $1
     ),
     -- The PO's products: its lines, plus the header's rfq_product_id array.
     products AS (
       SELECT pop.rfq_product_id::int AS id FROM tbl_purchase_order_product pop
        WHERE pop.purchase_order_id = $1 AND pop.rfq_product_id IS NOT NULL
       UNION
       SELECT unnest(rfq_product_id)::int FROM po
     )
     SELECT
       (SELECT r.created_by FROM tbl_rfq r JOIN po ON po.rfq_id = r.id) AS rfq_creator,
       (SELECT initiated_by FROM po) AS po_initiator,
       COALESCE(
         (SELECT ai.initiated_by
            FROM tbl_approval_instances ai
           WHERE ai.entity_type = 'NEGOTIATION_QUOTE'
             AND ai.status = 'APPROVED'
             AND ai.entity_id IN (SELECT id FROM products)
           ORDER BY COALESCE(ai.completed_at, ai.created_at) DESC, ai.id DESC
           LIMIT 1),
         (SELECT qfh.created_by
            FROM tbl_quote_finalization_history qfh
            JOIN po ON qfh.rfq_id = po.rfq_id AND qfh.vendor_id = po.finalized_vendor_id
           ORDER BY qfh.id DESC
           LIMIT 1)
       ) AS commercial_evaluator,
       (SELECT ai.initiated_by
          FROM tbl_approval_instances ai
          JOIN po ON ai.metadata->>'rfq_id' = po.rfq_id::text
         WHERE ai.entity_type = 'TECHNICAL'
           AND ai.status = 'APPROVED'
         ORDER BY COALESCE(ai.completed_at, ai.created_at) DESC, ai.id DESC
         LIMIT 1) AS technical_evaluator`,
    [poId]
  );
  const byRole = {
    RFQ_CREATOR: ids.rfq_creator,
    PO_INITIATOR: ids.po_initiator,
    COMMERCIAL_EVALUATOR: ids.commercial_evaluator,
    TECHNICAL_EVALUATOR: ids.technical_evaluator,
  };
  const userIds = [...new Set(Object.values(byRole).filter((v) => v != null).map(Number))];
  const users = userIds.length
    ? await conn.any(
        `SELECT id, name, status, COALESCE(is_deleted, 0) AS is_deleted, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
        [userIds]
      )
    : [];
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const canSee = new Map();
  for (const u of users) {
    try {
      await assertPoAccess({ id: Number(u.id), user_type: u.user_type }, poId, conn);
      canSee.set(Number(u.id), true);
    } catch (err) {
      if (!(err instanceof PoAccessError)) throw err;
      canSee.set(Number(u.id), false);
    }
  }

  return TARGET_ROLES.map((role) => {
    const id = byRole[role] == null ? null : Number(byRole[role]);
    const u = id == null ? null : byId.get(id);
    if (!u) return { target_role: role, user: null, available: false, unavailable_reason: NOBODY_REASON[role] };
    const user = { id, name: u.name || null };
    let reason = null;
    if (id === Number(callerId)) reason = 'You cannot ask yourself.';
    else if (Number(u.status) !== 1 || Number(u.is_deleted) === 1 || Number(u.user_type) === 3) {
      reason = "This person's account is not active.";
    } else if (!canSee.get(id)) reason = 'This person cannot see this purchase order.';
    return reason
      ? { target_role: role, user, available: false, unavailable_reason: reason }
      : { target_role: role, user, available: true };
  });
}

/** GET /po/:po_id/send-back/targets, after precheckAsker. */
export async function listTargets(user, poId) {
  return resolveTargets(db, Number(poId), user.id);
}

// ── The thread ────────────────────────────────────────────────────────────

const person = (id, name) => (id == null ? null : { id: Number(id), name: name || null });

const SEND_BACK_SELECT = `
  SELECT sb.id, sb.purchase_order_id, sb.route, sb.reason_category, sb.comment,
         sb.requested_by, ur.name AS requested_by_name,
         sb.target_role, sb.target_user_id, ut.name AS target_name,
         sb.status, sb.response_text, sb.responded_by, ure.name AS responded_by_name,
         sb.responded_at, sb.resolution, sb.created_at, sb.closed_at
    FROM tbl_po_send_backs sb
    LEFT JOIN tbl_users ur  ON ur.id  = sb.requested_by
    LEFT JOIN tbl_users ut  ON ut.id  = sb.target_user_id
    LEFT JOIN tbl_users ure ON ure.id = sb.responded_by`;

async function shapeRows(conn, rows) {
  if (!rows.length) return [];
  const files = await conn.any(
    `SELECT id, send_back_id, side, file_url, file_name
       FROM tbl_po_send_back_files WHERE send_back_id = ANY($1::int[]) ORDER BY id`,
    [rows.map((r) => r.id)]
  );
  const filesBy = new Map();
  for (const f of files) {
    const k = Number(f.send_back_id);
    if (!filesBy.has(k)) filesBy.set(k, []);
    filesBy.get(k).push({ id: Number(f.id), side: f.side, name: f.file_name || null, url: signedFileUrl(f.file_url) });
  }
  return rows.map((r) => ({
    id: Number(r.id),
    route: r.route,
    reason_category: r.reason_category,
    comment: r.comment,
    requested_by: person(r.requested_by, r.requested_by_name),
    target_role: r.target_role || null,
    target: person(r.target_user_id, r.target_name),
    status: r.status,
    response_text: r.response_text ?? null,
    responded_by: person(r.responded_by, r.responded_by_name),
    responded_at: r.responded_at || null,
    resolution: r.resolution || null,
    created_at: r.created_at,
    closed_at: r.closed_at || null,
    files: filesBy.get(Number(r.id)) || [],
  }));
}

/** Every send-back of the PO (holds and rejections), newest first. */
export async function listSendBacks(poId) {
  const rows = await db.any(
    `${SEND_BACK_SELECT} WHERE sb.purchase_order_id = $1 ORDER BY sb.created_at DESC, sb.id DESC`,
    [Number(poId)]
  );
  return shapeRows(db, rows);
}

/** One send-back in the thread's shape. */
export async function loadSendBack(sendBackId) {
  const rows = await db.any(`${SEND_BACK_SELECT} WHERE sb.id = $1`, [Number(sendBackId)]);
  return (await shapeRows(db, rows))[0] || null;
}

// ── Writes ────────────────────────────────────────────────────────────────

/** Uploaded files (multer-s3) for a send-back that was never written. Never throws. */
export async function discardUploads(files) {
  for (const f of files || []) {
    if (!f?.key || !f?.bucket) continue;
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: f.bucket, Key: f.key }));
    } catch (err) {
      logError('poSendBack: could not remove an unused upload', err);
    }
  }
}

async function insertFiles(t, sendBackId, side, files, userId) {
  for (const f of files || []) {
    await t.none(
      `INSERT INTO tbl_po_send_back_files (send_back_id, side, file_url, file_name, mime_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sendBackId, side, f.location, f.originalname || null, f.mimetype || null, userId]
    );
  }
}

/** Locks the PO, then its current approval instance (if any). Returns the PO. */
async function lockPoAndInstance(t, poId) {
  const po = await lockPo(t, poId);
  if (!po) throw new PoAccessError();
  if (po.approval_instance_id != null) {
    await t.oneOrNone(`SELECT id FROM tbl_approval_instances WHERE id = $1 FOR UPDATE`, [po.approval_instance_id]);
  }
  return po;
}

/**
 * Open a hold: ask `targetRole` for information on the PO.
 * Validates, then in one transaction (PO, instance, send-back) re-checks that
 * the caller is a pending approver on the current step and nothing is open,
 * resolves the person asked and writes the row, its files and the SEND_BACK
 * action. Notifies after COMMIT.
 *
 * @returns {Promise<Object>} the send-back, in the thread's shape
 */
export async function createInfoRequest({ user, poId, targetRole, reasonCategory, comment, route, files = [] }) {
  if (route != null && route !== '' && route !== 'INFO_REQUEST') {
    throw refuse(
      route === 'TECHNICAL'
        ? 'Sending a purchase order back to technical evaluation is not available yet.'
        : 'Use Reject to send a purchase order back for re-award or to cancel it.',
      'ROUTE_NOT_AVAILABLE', 400
    );
  }
  if (!INFO_REASONS.includes(reasonCategory)) {
    throw refuse(
      REJECTION_ONLY_REASONS.includes(reasonCategory)
        ? 'That reason means rejecting the purchase order. Use Reject instead.'
        : 'Choose one of the listed reasons.',
      'INVALID_REASON', 400
    );
  }
  const text = comment == null ? '' : String(comment).trim();
  if (!text) throw refuse('Say what you need to know.', 'COMMENT_REQUIRED', 400);
  if (!TARGET_ROLES.includes(targetRole)) throw refuse('Choose who to ask.', 'INVALID_TARGET', 400);

  let created;
  try {
    created = await db.tx(async (t) => {
      const po = await lockPo(t, poId);
      if (!po) throw new PoAccessError();
      if (!po.rfq_id) {
        throw refuse('Information requests are not available on call-off purchase orders.', 'CALL_OFF_NOT_SUPPORTED', 400);
      }
      if (po.approval_instance_id == null) throw stepNotPending();
      const instance = await lockCurrentPoInstance(t, po, null);
      if (instance.status !== 'PENDING' || po.status !== 'pending_approval') throw stepNotPending();
      const step = await pendingStepOf(t, instance.id, user.id);
      if (!step) throw stepNotPending();
      await assertPoNotOnHold(t, po.id);

      const target = (await resolveTargets(t, po.id, user.id)).find((x) => x.target_role === targetRole);
      if (!target?.available) {
        throw refuse(target?.unavailable_reason || 'Choose who to ask.', 'INVALID_TARGET', 400);
      }

      const { id } = await t.one(
        `INSERT INTO tbl_po_send_backs
           (purchase_order_id, rfq_id, approval_instance_id, approval_instance_step_id, step_order,
            route, reason_category, comment, requested_by, target_role, target_user_id)
         VALUES ($1, $2, $3, $4, $5, 'INFO_REQUEST', $6, $7, $8, $9, $10)
         RETURNING id`,
        [po.id, po.rfq_id, instance.id, step.id, step.step_order, reasonCategory, text, user.id, targetRole, target.user.id]
      );
      await insertFiles(t, id, 'REQUEST', files, user.id);
      await t.none(
        `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
         VALUES ($1, $2, $3, 'SEND_BACK', $4)`,
        [instance.id, step.id, user.id, text]
      );
      return { id: Number(id), instanceId: instance.id, targetUserId: target.user.id };
    });
  } catch (err) {
    // ux_po_send_back_one_open: someone opened a hold without the PO lock.
    // Same answer as the ordinary check, never a 500.
    if (err?.code === '23505' && err?.constraint === 'ux_po_send_back_one_open') {
      throw poOnHoldError(await findOpenHold(db, poId));
    }
    throw err;
  }

  // COMMIT has happened.
  notifyApprovalChanged({ instanceIds: [created.instanceId], extraUserIds: [created.targetUserId] });
  void notifySendBackRequested({ sendBackId: created.id, actorId: user.id });
  logger.info({ poId, sendBackId: created.id, targetRole }, 'PO put on hold for information');
  return loadSendBack(created.id);
}

/**
 * The person asked answers: text, files or both. The hold closes (ANSWERED,
 * RESUMED) and the step carries on. Only the person asked, while they can
 * still see the PO; anyone else gets 404.
 */
export async function respondToInfoRequest({ user, sendBackId, responseText, files = [] }) {
  const text = responseText == null ? '' : String(responseText).trim();
  if (!text && !files.length) {
    throw refuse('Write an answer or attach a file.', 'RESPONSE_REQUIRED', 400);
  }

  const out = await db.tx(async (t) => {
    const peek = await t.oneOrNone(`SELECT purchase_order_id FROM tbl_po_send_backs WHERE id = $1`, [sendBackId]);
    if (!peek) throw new PoAccessError();
    await lockPoAndInstance(t, peek.purchase_order_id);
    const sb = await t.one(
      `SELECT id, purchase_order_id, approval_instance_id, approval_instance_step_id, route, status, target_user_id
         FROM tbl_po_send_backs WHERE id = $1 FOR UPDATE`,
      [sendBackId]
    );
    if (sb.route !== 'INFO_REQUEST' || Number(sb.target_user_id) !== Number(user.id)) throw new PoAccessError();
    await assertPoAccess(user, sb.purchase_order_id, t);
    if (sb.status !== 'OPEN') throw holdNotOpen(sb.status);

    await t.none(
      `UPDATE tbl_po_send_backs
          SET status = 'ANSWERED', resolution = 'RESUMED', response_text = $2,
              responded_by = $3, responded_at = now(), closed_at = now()
        WHERE id = $1`,
      [sb.id, text || null, user.id]
    );
    await insertFiles(t, sb.id, 'RESPONSE', files, user.id);
    await t.none(
      `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'SEND_BACK_ANSWERED', $4)`,
      [sb.approval_instance_id, sb.approval_instance_step_id, user.id, text || null]
    );
    return { poId: Number(sb.purchase_order_id), instanceId: Number(sb.approval_instance_id) };
  });

  notifyApprovalChanged({ instanceIds: [out.instanceId], extraUserIds: [user.id] });
  void notifySendBackAnswered({ sendBackId: Number(sendBackId), actorId: user.id });
  logger.info({ poId: out.poId, sendBackId }, 'PO hold answered');
  return { poId: out.poId, sendBack: await loadSendBack(sendBackId) };
}

/**
 * Withdraw a hold: whoever asked, or any approver still PENDING on the held
 * step. 404 for someone who cannot reach the PO, 403 NOT_ALLOWED for someone
 * who can but is neither, 409 HOLD_NOT_OPEN once it is closed.
 */
export async function withdrawInfoRequest({ user, sendBackId, note }) {
  const peek = await db.oneOrNone(`SELECT purchase_order_id FROM tbl_po_send_backs WHERE id = $1`, [sendBackId]);
  if (!peek) throw new PoAccessError();
  await assertApproverSideAccess(user, peek.purchase_order_id);
  const text = note == null ? '' : String(note).trim();

  const out = await db.tx(async (t) => {
    await lockPoAndInstance(t, peek.purchase_order_id);
    const sb = await t.one(
      `SELECT id, purchase_order_id, approval_instance_id, approval_instance_step_id, status, requested_by, target_user_id
         FROM tbl_po_send_backs WHERE id = $1 FOR UPDATE`,
      [sendBackId]
    );
    const isRequester = Number(sb.requested_by) === Number(user.id);
    const onStep = !isRequester && sb.approval_instance_step_id != null && !!(await t.oneOrNone(
      `SELECT 1 FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id = $1 AND approver_user_id = $2
          AND status = 'PENDING' AND removed_at IS NULL
        LIMIT 1`,
      [sb.approval_instance_step_id, user.id]
    ));
    if (!isRequester && !onStep) throw notAllowed();
    if (sb.status !== 'OPEN') throw holdNotOpen(sb.status);

    await t.none(
      `UPDATE tbl_po_send_backs SET status = 'WITHDRAWN', resolution = NULL, closed_at = now() WHERE id = $1`,
      [sb.id]
    );
    await t.none(
      `INSERT INTO tbl_approval_actions (approval_instance_id, approval_instance_step_id, approver_user_id, action, comment)
       VALUES ($1, $2, $3, 'SEND_BACK_WITHDRAWN', $4)`,
      [sb.approval_instance_id, sb.approval_instance_step_id, user.id, text || null]
    );
    return {
      poId: Number(sb.purchase_order_id),
      instanceId: Number(sb.approval_instance_id),
      targetUserId: sb.target_user_id == null ? null : Number(sb.target_user_id),
    };
  });

  notifyApprovalChanged({
    instanceIds: [out.instanceId],
    extraUserIds: out.targetUserId ? [out.targetUserId] : [],
  });
  void notifySendBackWithdrawn({ sendBackId: Number(sendBackId), actorId: user.id, note: text || null });
  logger.info({ poId: out.poId, sendBackId }, 'PO hold withdrawn');
  return { poId: out.poId, sendBack: await loadSendBack(sendBackId) };
}
