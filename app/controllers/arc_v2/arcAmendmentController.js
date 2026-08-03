import { logger } from '../../util/logger.js';
import db from '../../config/dbConn.js';
import arcAmendmentModel from '../../models/arc_v2/arcAmendmentModel.js';
import { prepareAddendumForSignature } from '../../services/arcAddendumService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { userCanAccessArc } from '../../helper/arc_v2/arcScope.js';
import {
  createApprovalInstance,
  submitApprovalAction,
  getApprovalInstanceDetails,
  findBestMatchingPolicyTx,
} from '../../models/generalModel.js';

/**
 * ARC v2 — Amendment controller.
 *
 * Vendor-initiated amendments routed through the central approval engine
 * (tbl_approval_policies / tbl_approval_instances). The amendment row keeps
 * a denormalized approval_chain JSONB cache for fast list rendering, but
 * the engine is the source of truth — every decision is funneled through
 * generalModel.submitApprovalAction and the cache refreshes after each
 * transition.
 *
 * Policy resolution order:
 *   1. entity_type = 'ARC_AMENDMENT'  (preferred — admin-configured)
 *   2. entity_type = 'ARC'            (fallback — reuse the ARC policy)
 * If neither exists, the request fails with 400.
 */

function ok(res, data, status = 1)  { return res.status(200).json({ status, message: 'success', data }); }
function bad(res, code, message, status = 0) { return res.status(code).json({ status, message }); }

const TYPES = new Set(['price', 'qty', 'item_add', 'item_remove', 'term']);

/**
 * Shape the engine's instance details into the chain structure the active
 * page renders. Each step:
 *   { step, role, approver_user_ids, status, decided_by, decided_at, comment }
 */
function shapeChain(details) {
  if (!details || !Array.isArray(details.steps)) return [];
  return details.steps.map((s) => {
    // Approvers tombstoned by the mid-flight reconciler (status='REMOVED' +
    // removed_at + removal_reason) are dropped here, once, for the whole step.
    //
    // getApprovalInstanceDetails deliberately passes tombstones through — the
    // approval-details surfaces have dedicated removed-approver UI that labels
    // them. This chain does not: ActiveStage.js renders `approver_names` as the
    // live approver list and derives `isCurrentApprover` from
    // `approver_user_ids`, which showed a removed approver the "your turn"
    // state plus the approve/reject controls. The engine still refuses the
    // action (generalModel.submitApprovalAction requires the approver's own row
    // to be PENDING), so this was a false affordance rather than an authz hole
    // — but it is also wrong data: this array is persisted verbatim into
    // tbl_arc_amendment.approval_chain, so the stale name outlives the request.
    //
    // Only PENDING rows are ever tombstoned (approvalPropagationService updates
    // `WHERE status = 'PENDING'`), so an approver who already APPROVED/REJECTED
    // can never be filtered out here and `decidedApprover` below is unaffected.
    const liveApprovers = (s.approvers || []).filter((a) => a.status !== 'REMOVED');

    // Roll up the step decision from the per-approver records. ANY-decision
    // steps complete on the first APPROVED/REJECTED action; ALL-decision
    // steps complete only once everyone has acted. The engine has already
    // collapsed this into s.status.
    const decidedApprover = liveApprovers.find((a) => a.status === 'APPROVED' || a.status === 'REJECTED');

    // Derive a human label from the policy step's source. The schema has
    // no dedicated label column, so we lean on approver_source_type +
    // approver_source_id (e.g., "USER #426" → name resolved by approvers).
    let role = `Step ${s.step_order}`;
    if (s.approver_source_type === 'ROLE')        role = 'Role-based approval';
    else if (s.approver_source_type === 'DEPARTMENT') role = 'Departmental approval';
    else if (liveApprovers.length === 1) role = liveApprovers[0].user_designation || liveApprovers[0].user_name || role;

    return {
      step: s.step_order,
      role,
      decision_rule:      s.decision_rule || 'ANY',
      approver_user_ids: liveApprovers.map((a) => a.user_id),
      approver_names:    liveApprovers.map((a) => a.user_name),
      status: (s.status || 'PENDING').toLowerCase(),
      decided_by: decidedApprover?.user_id || null,
      decided_at: decidedApprover?.acted_at || null,
      comment:    decidedApprover?.comment  || null,
    };
  });
}

async function refreshChainCache(amendmentId, instanceId, userId) {
  const details = await getApprovalInstanceDetails(instanceId, userId);
  const chain = shapeChain(details);
  // Mirror the engine's status into the amendment row.
  const newStatus =
    details.status === 'APPROVED' ? 'approved' :
    details.status === 'REJECTED' ? 'rejected' :
    'requested';
  const currentStep = Number(details.current_step) || 1;
  // Never downgrade lifecycle states: once the lifecycle service has moved
  // the row to live/ended/voided, a cache refresh must not pull it back to
  // 'approved' (the engine's view stops at approved/rejected).
  const row = await db.one(
    `UPDATE public.tbl_arc_amendment
        SET approval_chain = $1::jsonb,
            current_step   = $2,
            status         = CASE WHEN status IN ('awaiting_signature','live','ended','voided') THEN status ELSE $3 END,
            updated_at     = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING status`,
    [JSON.stringify(chain), currentStep, newStatus, amendmentId]
  );
  return { chain, status: row.status, engineStatus: newStatus, currentStep };
}

/**
 * Reconcile ALREADY-CACHED approval_chain values against the engine's live
 * tombstones, on read.
 *
 * Why this exists rather than a one-shot backfill: `approval_chain` is only
 * ever rewritten by refreshChainCache(), i.e. when the AMENDMENT controller
 * touches the engine (request / review / post-approval hook). The mid-flight
 * reconciler (approvalPropagationService) is a SECOND writer to the same
 * approval instance — it tombstones approvers on a role revoke, a policy edit
 * or a user deactivation, and it never touches tbl_arc_amendment. So any
 * PENDING amendment whose approver is removed between two controller touches
 * keeps a stale name in the cache until the next decision. A backfill would
 * correct today's rows and then go stale again on the very next removal; this
 * pass is correct for the rows already in production AND for every future
 * removal, costs one extra query for the whole list, and writes nothing.
 *
 * It is applied on the BUYER list endpoint because that is the only surface
 * that renders identities out of this cache (ActiveStage.js: `approver_names`
 * as the live approver list, `approver_user_ids` → isCurrentApprover → the
 * approve/reject controls). The vendor projection (arcAmendmentModel.vendorView)
 * strips names and ids to numbered levels, so it is unaffected.
 */
async function stripRemovedFromCachedChains(rows) {
  const instanceIds = [
    ...new Set(
      (rows || [])
        .filter((r) => r.approval_instance_id && Array.isArray(r.approval_chain) && r.approval_chain.length)
        .map((r) => Number(r.approval_instance_id))
    ),
  ];
  if (instanceIds.length === 0) return rows;

  const dead = await db.any(
    `SELECT s.approval_instance_id, s.step_order,
            sa.approver_user_id, u.name, u.designation
       FROM tbl_approval_instance_steps s
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
       LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
      WHERE s.approval_instance_id = ANY($1::int[])
        AND sa.status = 'REMOVED'`,
    [instanceIds]
  );
  if (dead.length === 0) return rows;

  // key: "<instance_id>:<step_order>" → { ids:Set<number>, labels:Set<string> }
  const byStep = new Map();
  for (const d of dead) {
    const key = `${Number(d.approval_instance_id)}:${Number(d.step_order)}`;
    let entry = byStep.get(key);
    if (!entry) { entry = { ids: new Set(), labels: new Set() }; byStep.set(key, entry); }
    entry.ids.add(Number(d.approver_user_id));
    // A single-approver step caches that person's designation-or-name as the
    // step's `role` label (see shapeChain). If that person is the one who was
    // removed, the label is just as wrong as the list was.
    if (d.name) entry.labels.add(d.name);
    if (d.designation) entry.labels.add(d.designation);
  }

  for (const row of rows) {
    if (!row.approval_instance_id || !Array.isArray(row.approval_chain)) continue;
    row.approval_chain = row.approval_chain.map((st) => {
      const entry = byStep.get(`${Number(row.approval_instance_id)}:${Number(st.step)}`);
      if (!entry) return st;
      const ids   = Array.isArray(st.approver_user_ids) ? st.approver_user_ids : [];
      const names = Array.isArray(st.approver_names)    ? st.approver_names    : [];
      // approver_names[i] pairs positionally with approver_user_ids[i] — both
      // are built by the same map in shapeChain — so filter by index.
      const keep = ids.map((_, i) => i).filter((i) => !entry.ids.has(Number(ids[i])));
      const roleIsDeadPerson = typeof st.role === 'string' && entry.labels.has(st.role);
      if (keep.length === ids.length && !roleIsDeadPerson) return st;
      return {
        ...st,
        approver_user_ids: keep.map((i) => ids[i]),
        approver_names:    keep.map((i) => names[i]).filter((n) => n !== undefined && n !== null),
        role: roleIsDeadPerson ? `Step ${st.step}` : st.role,
      };
    });
  }
  return rows;
}

// ============================================================
// POST /v1/arc-v2/amendments/request           (vendor-initiated)
// ============================================================
export async function requestAmendment(req, res) {
  try {
    const body = req.body || {};
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Authentication required');

    const arcContractId = Number(body.arc_contract_id);
    const type          = String(body.amendment_type || '').trim();
    const from          = body.amendment_from;
    const to            = body.amendment_to || null;
    const reason        = String(body.reason || '').trim();
    const payload       = body.payload || {};

    if (!arcContractId)        return bad(res, 400, 'arc_contract_id is required');
    if (!TYPES.has(type))      return bad(res, 400, `amendment_type must be one of: ${[...TYPES].join(', ')}`);
    if (!from)                 return bad(res, 400, 'amendment_from is required');
    if (!to && type !== 'item_remove' && type !== 'term') {
      return bad(res, 400, 'amendment_to is required for this amendment type');
    }
    if (!reason)               return bad(res, 400, 'reason is required');

    // Type-specific payload validation.
    if (type === 'price') {
      if (!Number(payload.arc_contract_line_id)) return bad(res, 400, 'payload.arc_contract_line_id is required for price revision');
      if (!(Number(payload.new_rate) > 0))       return bad(res, 400, 'payload.new_rate must be > 0');
    } else if (type === 'qty') {
      if (!Number(payload.arc_contract_line_id)) return bad(res, 400, 'payload.arc_contract_line_id is required for qty revision');
      if (!(Number(payload.new_qty) > 0))        return bad(res, 400, 'payload.new_qty must be > 0');
    } else if (type === 'item_add') {
      if (!Number(payload.product_variant_id))   return bad(res, 400, 'payload.product_variant_id is required for item add');
      if (!(Number(payload.new_qty) > 0))        return bad(res, 400, 'payload.new_qty must be > 0');
      if (!(Number(payload.new_rate) > 0))       return bad(res, 400, 'payload.new_rate must be > 0');
    } else if (type === 'item_remove') {
      if (!Number(payload.arc_contract_line_id)) return bad(res, 400, 'payload.arc_contract_line_id is required for item remove');
    }

    // Pull the contract + parent ARC so we have the full scope for policy
    // resolution and instance creation.
    const ctxRow = await db.oneOrNone(
      `SELECT c.id           AS arc_contract_id,
              c.arc_id,
              a.hospitality_company_id,
              a.hotel_id,
              a.department_id,
              a.process_id
         FROM tbl_arc_contract c
         JOIN tbl_arc a ON a.id = c.arc_id
        WHERE c.id = $1`,
      [arcContractId]
    );
    if (!ctxRow) return bad(res, 404, 'Contract not found', 2);

    // One-in-flight guard: while an amendment is requested/approved/live, the
    // same item can't get a second one — and only one term extension may be
    // in flight at a time. (Stricter than window-overlap: windows are
    // irrelevant; the in-flight amendment must conclude first.)
    const conflict = await arcAmendmentModel.findInFlightConflict({
      arc_contract_id: arcContractId,
      amendment_type:  type,
      arc_contract_line_id: payload.arc_contract_line_id || null,
      product_variant_id:   payload.product_variant_id || null,
    });
    if (conflict) {
      const what = type === 'term' ? 'a term extension' : 'an amendment for this item';
      const state = conflict.status === 'requested' ? 'in review' : conflict.status;
      return bad(res, 409,
        `Amendment #${conflict.id} (${state}) means ${what} is already in flight — wait for it to be approved, declined, or to end before raising another.`);
    }

    // Resolve the approval policy. Prefer ARC_AMENDMENT; fall back to ARC.
    const result = await db.tx(async (t) => {
      let policy = await findBestMatchingPolicyTx({
        entity_type: 'ARC_AMENDMENT',
        hospitality_company_id: ctxRow.hospitality_company_id,
        hotel_id:               ctxRow.hotel_id,
        department_id:          ctxRow.department_id,
        process_id:             ctxRow.process_id,
      }, t);
      if (!policy) {
        policy = await findBestMatchingPolicyTx({
          entity_type: 'ARC',
          hospitality_company_id: ctxRow.hospitality_company_id,
          hotel_id:               ctxRow.hotel_id,
          department_id:          ctxRow.department_id,
          process_id:             ctxRow.process_id,
        }, t);
      }
      if (!policy) {
        throw Object.assign(new Error('No approval policy configured for ARC amendments in this scope.'), { httpStatus: 400 });
      }

      // Insert the amendment row first so we have an id to bind the
      // instance to.
      const amendment = await arcAmendmentModel.createRequest({
        arc_contract_id: arcContractId,
        amendment_type:  type,
        amendment_from:  from,
        amendment_to:    to,
        reason,
        payload,
        requested_by:    userId,
        approval_chain:  [],
      }, t);

      // Create the approval instance through the central engine. The engine
      // returns an envelope { instance, policy, steps, totalSteps, ... } —
      // the row itself lives under .instance.
      const engineResult = await createApprovalInstance({
        entity_type:            'ARC_AMENDMENT',
        entity_id:              amendment.id,
        hospitality_company_id: ctxRow.hospitality_company_id,
        hotel_id:               ctxRow.hotel_id,
        department_id:          ctxRow.department_id,
        process_id:             ctxRow.process_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata: {
          arc_contract_id:      arcContractId,
          amendment_type:       type,
        },
        txContext: t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) {
        throw new Error('Approval engine did not return an instance id');
      }

      // Attach instance id to the amendment row.
      await t.none(
        `UPDATE public.tbl_arc_amendment SET approval_instance_id = $1 WHERE id = $2`,
        [instanceRow.id, amendment.id]
      );
      return { amendment_id: amendment.id, instance_id: instanceRow.id, arc_id: ctxRow.arc_id };
    });

    // Snapshot the chain into the cache (outside the tx — read-only). If the
    // engine auto-approved (initiator-only chains), generate the addendum and
    // park the amendment in 'awaiting_signature' — effects bind only once the
    // vendor re-signs the addendum (never on approval alone).
    const refreshed = await refreshChainCache(result.amendment_id, result.instance_id, userId);
    if (refreshed.engineStatus === 'approved') {
      await prepareAddendumForSignature(result.amendment_id, { actorId: userId });
      // Notify vendor that addendum awaits signature (BOTH email). actorId is
      // null here (not userId): the requester IS the vendor, and this event's
      // sole audience is that vendor — passing actorId:userId would self-suppress
      // and the vendor would never be told to sign. (Mirrors requestOtp.)
      await notifyArcEvent({
        arcId: result.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_AWAITING_SIGNATURE,
        actorId: null, payload: { vendorId: userId },
      });
    }
    const row = await arcAmendmentModel.getById(result.amendment_id);
    // Notify creator + comm evaluators of the amendment request (BOTH email)
    await notifyArcEvent({
      arcId: result.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_REQUESTED,
      actorId: userId, payload: { vendorId: userId },
    });
    // The requester is the vendor — return the anonymised (level-only) view.
    return ok(res, { amendment: arcAmendmentModel.vendorView(row), arc_id: result.arc_id });
  } catch (err) {
    logger.error({ err }, '[amendmentController.requestAmendment]');
    const code = err.httpStatus || 500;
    return bad(res, code, err.message || 'Internal error', code === 500 ? 3 : 0);
  }
}

// ============================================================
// GET /v1/arc-v2/amendments?arc_id=<id>  (also accepts arc_contract_id)
// ============================================================
export async function listAmendments(req, res) {
  try {
    const arcId      = Number(req.query.arc_id || 0);
    const contractId = Number(req.query.arc_contract_id || 0);
    if (!arcId && !contractId) return bad(res, 400, 'arc_id or arc_contract_id is required');
    // Both ids are client-supplied and sequential, and the rows carry vendor
    // identities plus the buyer approval chain. Resolve whichever was given
    // back to its ARC and gate on the ARC's OWN scope — never on the id alone.
    const scopeArc = await db.oneOrNone(
      arcId
        ? `SELECT a.id, a.hospitality_company_id, a.hotel_id, a.department_id, a.process_id
             FROM tbl_arc a WHERE a.id = $1`
        : `SELECT a.id, a.hospitality_company_id, a.hotel_id, a.department_id, a.process_id
             FROM tbl_arc_contract c JOIN tbl_arc a ON a.id = c.arc_id WHERE c.id = $1`,
      [arcId || contractId]
    );
    if (!scopeArc) return bad(res, 404, 'Rate contract not found', 2);
    if (!(await userCanAccessArc(req, scopeArc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }
    const rows = arcId
      ? await arcAmendmentModel.listForArc(arcId)
      : await arcAmendmentModel.listForContract(contractId);
    // Rows cached before this fix (and any row whose approver was tombstoned
    // by the reconciler since the last engine touch) still carry removed
    // approvers in approval_chain — drop them here, on read.
    await stripRemovedFromCachedChains(rows);
    return ok(res, { amendments: rows });
  } catch (err) {
    logger.error({ err }, '[amendmentController.listAmendments]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// GET /v1/arc-v2/vendor/amendments              (vendor — My Amendments)
//   Every amendment the vendor has raised, across all their contracts,
//   with ARC/BU context joined for the list page's search + filters.
//   Scope is derived from req.user — never from the query string.
// ============================================================
export async function listVendorAmendments(req, res) {
  try {
    const vendorId = req.user?.id;
    if (!vendorId) return bad(res, 401, 'Unauthenticated');
    const rows = await arcAmendmentModel.listForVendor(vendorId);
    // Strip buyer approver identities — vendors see numbered levels only.
    return ok(res, { amendments: rows.map(arcAmendmentModel.vendorView) });
  } catch (err) {
    logger.error({ err }, '[amendmentController.listVendorAmendments]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// POST /v1/arc-v2/amendments/:id/review        (buyer / approver)
//   Body: { decision:'approve'|'reject', comment?, edit?:{ ...payload overrides } }
//   Funnels through generalModel.submitApprovalAction. The engine handles
//   step transitions, ANY/ALL decision rules, and writes tbl_approval_actions.
// ============================================================
export async function reviewAmendment(req, res) {
  try {
    const amendmentId = Number(req.params.id);
    const userId      = req.user?.id;
    const decision    = String(req.body?.decision || '').trim();
    const comment     = req.body?.comment ? String(req.body.comment) : null;
    const edit        = req.body?.edit && typeof req.body.edit === 'object' ? req.body.edit : null;

    if (!amendmentId) return bad(res, 400, 'amendment id is required');
    if (!userId)      return bad(res, 401, 'Authentication required');
    if (decision !== 'approve' && decision !== 'reject') {
      return bad(res, 400, "decision must be 'approve' or 'reject'");
    }
    if (decision === 'reject' && !comment) {
      return bad(res, 400, 'A reason (comment) is required when rejecting');
    }

    const am = await arcAmendmentModel.getById(amendmentId);
    if (!am) return bad(res, 404, 'Amendment not found', 2);
    if (am.status !== 'requested') return bad(res, 400, `Amendment is ${am.status}, no further actions allowed`);
    if (!am.approval_instance_id)  return bad(res, 400, 'Amendment has no approval instance attached');

    // Edit-then-approve (counter-offer): compute per-field diffs against
    // the current payload, persist them to tbl_arc_amendment_edit_history,
    // merge into amendment.payload, and fold a human-readable summary into
    // the APPROVE comment so the central workflow's audit trail surfaces
    // the change to downstream approvers.
    let engineComment = comment;
    if (decision === 'approve' && edit) {
      const current = am.payload && typeof am.payload === 'object' ? am.payload : {};
      // amendment_from / amendment_to are columns, not payload keys (term
      // extension edits land here). Everything else merges into payload.
      const COLUMN_FIELDS = new Set(['amendment_from', 'amendment_to']);
      const diffs = [];
      const columnUpdates = {};
      const payloadEdit = {};
      for (const [field, after] of Object.entries(edit)) {
        if (COLUMN_FIELDS.has(field)) {
          const before = am[field] ? String(am[field]).slice(0, 10) : null;
          const afterStr = after ? String(after).slice(0, 10) : null;
          if (before === afterStr) continue;
          columnUpdates[field] = afterStr;
          diffs.push({ field_changed: field, before_value: before, after_value: afterStr });
        } else {
          const before = current[field];
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          payloadEdit[field] = after;
          diffs.push({ field_changed: field, before_value: before ?? null, after_value: after });
        }
      }
      if (diffs.length > 0) {
        await arcAmendmentModel.recordEdits(amendmentId, diffs, { changed_by: userId, comment });
        const sets = [];
        const args = [];
        let p = 1;
        if (Object.keys(payloadEdit).length > 0) {
          const merged = { ...current, ...payloadEdit, _edited_by: userId, _edited_at: new Date().toISOString() };
          sets.push(`payload = $${p++}::jsonb`);
          args.push(JSON.stringify(merged));
        }
        for (const [col, val] of Object.entries(columnUpdates)) {
          sets.push(`${col} = $${p++}`);
          args.push(val);
        }
        sets.push(`updated_at = CURRENT_TIMESTAMP`);
        args.push(amendmentId);
        await db.none(`UPDATE tbl_arc_amendment SET ${sets.join(', ')} WHERE id = $${p}`, args);
        const summary = diffs
          .map((d) => `${d.field_changed}: ${JSON.stringify(d.before_value)} → ${JSON.stringify(d.after_value)}`)
          .join('; ');
        engineComment = `[Edited before approval] ${summary}${comment ? ` — ${comment}` : ''}`;
      }
    }

    // Route the decision through the central engine.
    await submitApprovalAction({
      approval_instance_id: am.approval_instance_id,
      approver_user_id:     userId,
      action:               decision.toUpperCase(),
      comment:              engineComment,
    });

    // Refresh cache + status mirror, then — when the engine reached its
    // terminal APPROVED state — generate the addendum and park the amendment in
    // 'awaiting_signature'. Effects (term-date application, live/ended) are
    // applied later, when the vendor re-signs the addendum, not here.
    const refreshed = await refreshChainCache(amendmentId, am.approval_instance_id, userId);
    if (refreshed.engineStatus === 'approved') {
      await prepareAddendumForSignature(amendmentId, { actorId: userId });
      // Notify the vendor their amendment was approved + addendum awaits signature
      const arcCtx = await db.oneOrNone(
        `SELECT c.arc_id, am.requested_by AS vendor_id
           FROM tbl_arc_amendment am JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
          WHERE am.id = $1`, [amendmentId]
      );
      if (arcCtx) {
        await notifyArcEvent({
          arcId: arcCtx.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_APPROVED,
          actorId: userId, payload: { vendorId: arcCtx.vendor_id },
        });
        await notifyArcEvent({
          arcId: arcCtx.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_AWAITING_SIGNATURE,
          actorId: userId, payload: { vendorId: arcCtx.vendor_id },
        });
      }
    } else if (refreshed.engineStatus === 'rejected') {
      const arcCtx = await db.oneOrNone(
        `SELECT c.arc_id, am.requested_by AS vendor_id
           FROM tbl_arc_amendment am JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
          WHERE am.id = $1`, [amendmentId]
      );
      if (arcCtx) {
        await notifyArcEvent({
          arcId: arcCtx.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_REJECTED,
          actorId: userId, payload: { vendorId: arcCtx.vendor_id },
        });
      }
    }
    const row = await arcAmendmentModel.getById(amendmentId);
    return ok(res, { amendment: row });
  } catch (err) {
    logger.error({ err }, '[amendmentController.reviewAmendment]');
    const msg = err.message || 'Internal error';
    const code = /not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step|policy/i.test(msg) ? 400 : 500;
    return bad(res, code, msg, code === 500 ? 3 : 0);
  }
}

// ============================================================
// Post-approval hooks — wired into approvalActionService so decisions taken
// through the GENERIC approvals surface (not /amendments/:id/review) still
// mirror onto the amendment row and trigger lifecycle effects. The review
// endpoint does the same work inline, so both paths converge; the helpers
// are idempotent.
// ============================================================
export async function handleArcAmendmentApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const am = await db.oneOrNone(
      `SELECT am.id, c.arc_id, am.requested_by AS vendor_id
         FROM public.tbl_arc_amendment am
         JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
        WHERE am.approval_instance_id = $1`,
      [approvalInstanceId]
    );
    if (!am) {
      logger.warn({ approvalInstanceId }, '[amendmentController.handleArcAmendmentApproval] no amendment for instance');
      return;
    }
    await refreshChainCache(am.id, approvalInstanceId, approverUserId);
    await prepareAddendumForSignature(am.id, { actorId: approverUserId });
    // Notify the vendor their amendment was approved + addendum awaits signature (BOTH email)
    await notifyArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_APPROVED,
      actorId: approverUserId, payload: { vendorId: am.vendor_id },
    });
    await notifyArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_AWAITING_SIGNATURE,
      actorId: approverUserId, payload: { vendorId: am.vendor_id },
    });
    logger.info({ approvalInstanceId, amendmentId: am.id },
      '[amendmentController.handleArcAmendmentApproval] amendment approved via central engine — addendum awaiting vendor signature');
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[amendmentController.handleArcAmendmentApproval]');
  }
}

export async function handleArcAmendmentRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const am = await db.oneOrNone(
      `SELECT am.id, c.arc_id, am.requested_by AS vendor_id
         FROM public.tbl_arc_amendment am
         JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
        WHERE am.approval_instance_id = $1`,
      [approvalInstanceId]
    );
    if (!am) {
      logger.warn({ approvalInstanceId }, '[amendmentController.handleArcAmendmentRejection] no amendment for instance');
      return;
    }
    await refreshChainCache(am.id, approvalInstanceId, approverUserId);
    // Notify the vendor their amendment was rejected (BOTH email)
    await notifyArcEvent({
      arcId: am.arc_id, eventType: ARC_EVENT_TYPES.AMENDMENT_REJECTED,
      actorId: approverUserId, payload: { vendorId: am.vendor_id },
    });
    logger.info({ approvalInstanceId, amendmentId: am.id },
      '[amendmentController.handleArcAmendmentRejection] amendment rejected via central engine');
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[amendmentController.handleArcAmendmentRejection]');
  }
}

// Legacy approve/reject — kept as 501 so old clients see a clear hint.
export function approveAmendment(req, res) {
  return res.status(501).json({ status: 0, message: 'Use POST /amendments/:id/review with decision="approve" instead.' });
}
export function rejectAmendment(req, res) {
  return res.status(501).json({ status: 0, message: 'Use POST /amendments/:id/review with decision="reject" instead.' });
}
