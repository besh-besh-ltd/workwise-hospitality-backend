import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import rbacModel from '../../models/rbacModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { logger } from '../../util/logger.js';
import { resolveHospitalityCompanyId, resolveHospitalityCompanyScope } from '../../helper/arc_v2/resolveHospitalityCompany.js';
import { userCanAccessArc, arcScopeUserId, buildArcScopeClause, filterRowsByProcessAxis } from '../../helper/arc_v2/arcScope.js';
import { dispatch as dispatchNotification } from '../../services/notificationService.js';
import { sendMail } from '../../helper/common.js';
import { arcMomentIst, windowClosed, windowNotOpen, nowIst } from '../../helper/arcTime.js';
import { currentFinancialYearIst } from '../../helper/financialYear.js';
import {
  createApprovalInstance,
  findBestMatchingPolicyTx,
  cancelApprovalInstance,
  getApprovalInstanceDetails,
} from '../../models/generalModel.js';
import { executeApprovalAction, dispatchPostApprovalAction } from '../../services/approvalActionService.js';

/**
 * ARC v2 — Buyer-side controller for the ARC root entity.
 *
 * Endpoints surfaced by app/routes/arc_v2/contractRoutes.js. Wizard flow:
 *   POST   /             → createDraft
 *   PATCH  /:id          → updateDraft
 *   POST   /:id/publish  → publish (Draft → Floated)
 *   POST   /:id/withdraw → withdraw (creator-only)
 *   POST   /:id/terminate → terminate
 *   GET    /             → list (with filter presets — sidebar sub-links)
 *   GET    /:id          → getById
 *   GET    /kpis         → dashboardCounts (sidebar live badges)
 *   GET    /category-departments?category_id= → departments allowed for category × user
 *   GET    /sub-categories?category_id=        → sub-categories under a category
 *
 * Permissions enforced by acl() at the route layer.
 */

function ok(res, data, message = 'success') {
  return res.status(200).json({ status: 1, message, data });
}
function bad(res, status, message, code = 0) {
  return res.status(status).json({ status: code, message });
}

// Authorization: may this caller act on the given hotel / ARC row?
//
// This used to be one of FOUR byte-identical copies (here,
// arcContractController, arcCommitteeController, arcManualController), all
// wrapping rbacModel.getAllAccessibleHotelIds — which reads the HOTEL-BLIND
// tbl_hospitality_user_mappings and expands any company-level mapping to every
// hotel in the company, so a single-BU user could read every other BU's rate
// contracts. All four now delegate to the ONE implementation in
// helper/arc_v2/arcScope.js, which enforces the same 4-axis RBAC matrix
// (company × hotel × department × process) as authorizationService.
//
// Prefer passing the ARC ROW (not just its hotel id) — the row form also
// enforces the department and process axes.
const userCanAccessHotel = userCanAccessArc;

// Notify every invited vendor that an ARC was floated (audit C2). Best-effort
// and post-commit: a notification/email failure must NEVER roll back or block
// the float. In-app/push/socket goes via notificationService.dispatch; email
// is fire-and-forget on top.
//
// Exported (Sr 27 / Option C) so the ARC submission-open sweep
// (arcSubmissionOpenService.js) can fire this EXACT same notification later,
// for an ARC that floated with a future submission_start_at — one notify
// implementation, two callers (immediate float below, or the deferred sweep),
// never a parallel copy.
export async function notifyVendorsOfFloat(arc, invitations, actorId) {
  const vendorIds = invitations.map((i) => Number(i.vendor_id)).filter(Boolean);
  if (vendorIds.length === 0) return;
  const deadline = arc.submission_end_at ? arcMomentIst(arc.submission_end_at).format('DD MMM YYYY') : null;
  try {
    await dispatchNotification({
      userIds: vendorIds,
      senderUserId: actorId,
      category: 'ARC',
      type: 'ARC_FLOATED',
      title: 'New rate contract opportunity',
      body: deadline
        ? `${arc.title} is open for quotes until ${deadline}.`
        : `${arc.title} is open for quotes.`,
      data: { arc_id: arc.id, arc_number: arc.arc_number },
      actionUrl: '/dashboard/vendor/rate-contracts/requests',
    });
  } catch (err) {
    logger.error({ err, arcId: arc.id }, '[arcController.publish] in-app vendor notify failed');
  }
  for (const inv of invitations) {
    if (!inv.vendor_email) continue;
    sendMail({
      to: inv.vendor_email,
      subject: `New rate contract opportunity: ${arc.title}`,
      html: `<p>Hello ${inv.vendor_name || 'Vendor'},</p>
             <p>A new rate contract <strong>${arc.title}</strong> (${arc.arc_number}) is open for quotes${deadline ? ` until <strong>${deadline}</strong>` : ''}.</p>
             <p>Please log in to your vendor portal to review and submit your quote.</p>`,
    }).catch((err) =>
      logger.error({ err, arcId: arc.id, vendor: inv.vendor_id }, '[arcController.publish] vendor email failed')
    );
  }
}

/**
 * Float an ARC live: resolve + persist the vendor panel, flip to 'floated',
 * and return the data needed to notify vendors. This is the reusable extraction
 * of today's publish side-effects, called by the post-approval hook (and never
 * directly by publish, which now only creates the approval instance).
 *
 * It does NOT do auth, status-gating, or window validation (those belong to
 * publish). It RE-CHECKS the vendor panel at call time (RESOLVED 6) — if empty,
 * it returns { floated:false, reason:'no_vendors' } WITHOUT flipping; the caller
 * decides what to do (the approval hook flips to publish_rejected). It NEVER
 * notifies vendors itself — when a txContext is passed the notify must run after
 * the outer commit, so floatArc returns _notifyArc/_actorId and the CALLER fires
 * notifyVendorsOfFloat post-commit (RESOLVED 7).
 *
 * @returns { floated:true, arc, invitations, _notifyArc, _actorId }
 *        | { floated:false, reason:'no_vendors' }
 */
async function floatArc(arcId, actorId, { txContext = null } = {}) {
  const runner = txContext || db;
  const arc = await arcModel.getById(arcId, runner);
  if (!arc) return { floated: false, reason: 'arc_not_found' };

  // Resolve the vendor panel (same logic as today's publish): "open" resolves
  // eligible vendors for (category, hotel); "invitation" uses the rows set at
  // createDraft.
  let vendorIds;
  if (arc.eligibility_type === 'open') {
    const eligible = await arcModel.getEligibleVendorsForCategory(
      { category_id: arc.category_id, hotel_id: arc.hotel_id }, runner);
    vendorIds = eligible.map((v) => Number(v.id));
  } else {
    const inv = await arcModel.listInvitations(arcId, runner);
    vendorIds = inv.map((i) => Number(i.vendor_id));
  }
  if (vendorIds.length === 0) return { floated: false, reason: 'no_vendors' };

  const items = await arcModel.listItems(arcId, runner);

  const doFloat = async (t) => {
    const updated = await arcModel.setStatus(arcId, 'floated', {}, t);
    if (arc.eligibility_type === 'open') await arcModel.setInvitations(arcId, vendorIds, t);
    const invitations = await arcModel.listInvitations(arcId, t);
    await logArcEvent({
      arcId, eventType: ARC_EVENT_TYPES.PUBLISHED, actorId,
      payload: { item_count: items.length, vendor_count: invitations.length }, txContext: t,
    });
    return { updated, invitations };
  };

  // Honour an outer tx if given (the post-approval hook supplies one); else open
  // our own. Vendor notify is ALWAYS deferred to the caller (post-commit).
  const res = txContext ? await doFloat(txContext) : await db.tx(doFloat);
  return { floated: true, arc: res.updated, invitations: res.invitations, _notifyArc: arc, _actorId: actorId };
}

export async function createDraft(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return bad(res, 401, 'Unauthorized');
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || !body.category_id ||
        !body.hotel_id || !body.department_id) {
      return bad(res, 400, 'title, category_id, hotel_id, department_id are required');
    }
    const hotelId = Number(body.hotel_id);
    // Derive the hotel's TRUE hospitality company server-side — never trust a
    // client-supplied hospitality_company_id (audit C4). Any body value is
    // ignored. This also unblocks the wizard, which never sends it (audit C1).
    const [hotelMapping] = await rbacModel.getHotelCompanyMappings([hotelId]);
    if (!hotelMapping) return bad(res, 400, 'invalid hotel_id');
    // Authorize against the hotel's own scope: the caller must be able to act
    // on this hotel, else they could mint a contract in another tenant (C4).
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel');
    }
    const data = {
      // arc_number is minted below, INSIDE the tx (FY-scoped atomic upsert) —
      // never trust a client-supplied arc_number (L1).
      title,
      description: body.description,
      category_id: body.category_id,
      sub_category_ids: Array.isArray(body.sub_category_ids) ? body.sub_category_ids : [],
      hospitality_company_id: Number(hotelMapping.hospitality_company_id),
      hotel_id: hotelId,
      department_id: body.department_id,
      // ARC approval routes via the committee/hierarchy model, not an approval
      // process — process_id is optional and defaults to NULL (audit H5).
      process_id: body.process_id ?? null,
      submission_start_at: body.submission_start_at,
      submission_end_at: body.submission_end_at,
      contract_start_at: body.contract_start_at,
      contract_end_at: body.contract_end_at,
      technical_response_required: !!body.technical_response_required,
      sample_required: !!body.sample_required,
      eligibility_type: body.eligibility_type || 'open',
      escalation_clause_json: body.escalation_clause_json || {},
      payment_terms_expected: body.payment_terms_expected,
      delivery_expected: body.delivery_expected,
      penalty_clause: body.penalty_clause,
      // product vs service — collected by the wizard's Basics step (defaults to
      // 'product' so resume can rehydrate it). Stored on tbl_arc.type.
      type: body.type || 'product',
      created_by: userId,
    };
    // Respond-AFTER-commit: build the payload inside the tx, send it only once
    // the transaction has committed. Responding inside db.tx() races the COMMIT —
    // the client can read back the new ARC on another connection and 404 on it,
    // and a failing COMMIT can no longer surface as a 500 because the headers
    // are already on the wire. Mirrors terminate() / verifyOtp().
    const created = await db.tx(async (t) => {
      // Mint the FY-scoped serial inside the tx that creates the ARC row, so a
      // rollback never leaves the per-FY counter bumped without a matching ARC
      // (skipped serial on rollback is fine; a duplicate would not be).
      const arcNumber = await arcModel.nextArcNumber(currentFinancialYearIst(), t);
      const arc = await arcModel.createDraft({ ...data, arc_number: arcNumber }, t);
      // Seed items if any were provided up-front (multi-step wizard might add them later via PATCH).
      const items = Array.isArray(body.items) ? body.items : [];
      const createdItems = [];
      for (const it of items) {
        if (!it.product_variant_id || it.indicative_qty == null) continue;
        createdItems.push(await arcModel.addItem(arc.id, it, t));
      }
      // Invitations (if invitation-only).
      if (data.eligibility_type === 'invitation' && Array.isArray(body.invited_vendor_ids)) {
        await arcModel.setInvitations(arc.id, body.invited_vendor_ids, t);
      }
      await logArcEvent({
        arcId: arc.id, eventType: ARC_EVENT_TYPES.CREATED,
        actorId: userId, payload: { items: createdItems.length },
        txContext: t,
      });
      return { arc, items: createdItems };
    });
    return ok(res, created, 'ARC draft created');
  } catch (err) {
    logger.error({ err }, '[arcController.createDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function updateDraft(req, res) {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const existing = await arcModel.getById(id);
    if (!existing) return bad(res, 404, 'ARC not found', 2);
    // A publish-rejected ARC is editable again (RESOLVED 4): the creator revises
    // and re-publishes (which spawns a fresh approval instance).
    if (!['draft','publish_rejected'].includes(existing.status)) {
      return bad(res, 409, 'Only drafts can be edited');
    }
    // Security-first (audit C4 pattern — mirrors createDraft/publish/getById):
    // reload-and-verify the draft belongs to a hotel the caller can act on
    // before mutating it. Without this the :id path param alone would let any
    // authenticated buyer PATCH (and now, with the item/invitation persistence
    // below, meaningfully mutate) another tenant's draft ARC.
    if (!(await userCanAccessHotel(req, existing))) {
      return bad(res, 403, 'You do not have access to this rate contract');
    }

    // GROUP D (Sr 17/20 fix): updateDraft previously only whitelisted scalar
    // columns (see arcModel.updateDraft), so re-saving a RESUMED draft silently
    // dropped item / vendor-invitation edits — a data-loss trap for the new
    // "Save draft & exit" round-trip. Reconcile the item set and invitation
    // list here too, mirroring how createDraft seeds them, all inside one tx.
    const result = await db.tx(async (t) => {
      const updated = await arcModel.updateDraft(id, body, t);

      // Item set — delete/update/insert so add, edit (spec/qty/uom), and
      // remove of items on a resumed draft all persist. Only reconciled when
      // the caller actually sent an `items` array, so a scalar-only PATCH
      // (e.g. `{ type: 'service' }`) never touches — let alone wipes — it.
      let items = await arcModel.listItems(id, t);
      if (Array.isArray(body.items)) {
        const incoming = body.items.filter((it) => it && it.product_variant_id && it.indicative_qty != null);
        const byVariant = new Map(items.map((it) => [Number(it.product_variant_id), it]));
        const keepVariantIds = new Set(incoming.map((it) => Number(it.product_variant_id)));
        // Drop items the wizard no longer has selected. tbl_arc_item_tech_evaluation
        // (and its clauses) cascade-delete with the item, so no orphaned rows.
        for (const existingItem of items) {
          if (!keepVariantIds.has(Number(existingItem.product_variant_id))) {
            await arcModel.removeItem(existingItem.id, t);
          }
        }
        const nextItems = [];
        for (const it of incoming) {
          const match = byVariant.get(Number(it.product_variant_id));
          nextItems.push(match
            ? await arcModel.updateItem(match.id, {
                spec_text: it.spec_text || '',
                indicative_qty: it.indicative_qty,
                uom: it.uom || null,
              }, t)
            : await arcModel.addItem(id, it, t));
        }
        items = nextItems;
      }

      // Vendor invitations — same delete-and-replace `setInvitations` createDraft
      // uses, so invitation-only eligibility edits on a resumed draft persist too.
      if (Array.isArray(body.invited_vendor_ids)) {
        await arcModel.setInvitations(id, body.invited_vendor_ids, t);
      }

      // Tech-eval teardown (review P2): reconcile which items still require a
      // technical envelope. `tech_item_variant_ids` is the FE's current set of
      // tech-ON items (with clauses) for this save — mirrored from what it's
      // about to (re)persist via persistTechEval/setupTechEval right after this
      // call. Only runs when the caller explicitly sent the array (same gating
      // as items/invited_vendor_ids above), so a caller that never sends it
      // (e.g. a scalar-only PATCH, or an older client) never wipes existing
      // config. Any item in the reconciled `items` list whose variant is NOT
      // in the keep-set had its tech-eval toggled off — tear its
      // tbl_arc_item_tech_evaluation row (+ clauses) down so vendors are no
      // longer asked to seal an envelope / be tech-scored for it.
      if (Array.isArray(body.tech_item_variant_ids)) {
        const keepVariantIds = new Set(body.tech_item_variant_ids.map(Number));
        for (const it of items) {
          if (!keepVariantIds.has(Number(it.product_variant_id))) {
            await arcEvalModel.deleteTechEvalForItem(it.id, t);
          }
        }
      }

      return { updated, items };
    });

    return ok(res, { arc: result.updated, items: result.items }, 'ARC draft updated');
  } catch (err) {
    logger.error({ err }, '[arcController.updateDraft]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function publish(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    // Re-verify tenant ownership on publish — never flip a foreign ARC (C4).
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract');
    }
    // Publishable from a fresh draft OR a previously-rejected publish (RESOLVED 4).
    if (!['draft','publish_rejected'].includes(arc.status)) {
      return bad(res, 409, `Cannot publish ARC in status ${arc.status}`);
    }
    // Server-side completeness + window validation (audit M1). The wizard
    // surfaces these earlier — this is the fail-safe.
    const missing = [];
    if (!arc.submission_start_at) missing.push('submission_start_at');
    if (!arc.submission_end_at)   missing.push('submission_end_at');
    if (!arc.contract_start_at)   missing.push('contract_start_at');
    if (!arc.contract_end_at)     missing.push('contract_end_at');
    if (arc.submission_start_at && arc.submission_end_at &&
        new Date(arc.submission_start_at) >= new Date(arc.submission_end_at)) {
      missing.push('submission_start_at < submission_end_at');
    }
    if (arc.submission_end_at && arc.contract_start_at &&
        new Date(arc.submission_end_at) >= new Date(arc.contract_start_at)) {
      missing.push('submission_end_at < contract_start_at');
    }
    if (arc.contract_start_at && arc.contract_end_at &&
        new Date(arc.contract_start_at) >= new Date(arc.contract_end_at)) {
      missing.push('contract_start_at < contract_end_at');
    }
    if (windowClosed(arc)) {
      missing.push('submission_end_at must be in the future');
    }
    const items = await arcModel.listItems(id);
    if (items.length === 0) missing.push('at_least_one_item');
    if (missing.length > 0) return bad(res, 400, `Missing or invalid: ${missing.join(', ')}`);

    // Resolve the vendor panel BEFORE flipping so we can refuse to float to
    // nobody (audit M2). "open" resolves eligible vendors for (category, hotel);
    // "invitation" uses the rows set at createDraft.
    let vendorIds;
    if (arc.eligibility_type === 'open') {
      const eligible = await arcModel.getEligibleVendorsForCategory(
        { category_id: arc.category_id, hotel_id: arc.hotel_id }
      );
      vendorIds = eligible.map((v) => Number(v.id));
    } else {
      const inv = await arcModel.listInvitations(id);
      vendorIds = inv.map((i) => Number(i.vendor_id));
    }
    if (vendorIds.length === 0) {
      return bad(res, 400, 'No eligible vendors to invite — cannot float this rate contract to nobody');
    }

    // Publish no longer floats directly. It resolves the ARC's approval policy
    // (matched as entity_type 'ARC'), creates an ARC_PUBLISH approval instance,
    // and parks the ARC in pending_publish_approval. The ARC goes live ONLY when
    // the instance reaches APPROVED — the registered hook (handleArcPublishApproval)
    // calls floatArc. No policy → hard 400; the ARC stays draft/publish_rejected.
    const result = await db.tx(async (t) => {
      const policy = await findBestMatchingPolicyTx({
        entity_type:            'ARC',
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
      }, t);
      if (!policy) {
        const err = new Error('No approval policy configured to publish a rate contract in this scope. Configure an ARC approval policy (Settings → Approvals) for this company/hotel/department, then publish again.');
        err.httpStatus = 400;
        throw err;
      }
      const engineResult = await createApprovalInstance({
        entity_type:            'ARC_PUBLISH',
        entity_id:              id,
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata:               { item_count: items.length, vendor_count: vendorIds.length, eligibility_type: arc.eligibility_type },
        txContext:              t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');
      await arcModel.setStatus(id, 'pending_publish_approval', {}, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.PUBLISH_SUBMITTED,
        actorId: userId, payload: { approval_instance_id: instanceRow.id, vendor_count: vendorIds.length },
        txContext: t,
      });
      return { approval_instance_id: instanceRow.id, auto_approved: engineResult.autoApproved === true };
    });

    // Auto-approve: the engine births the instance APPROVED when the publisher
    // is the (sole/ANY) configured approver, so executeApprovalAction never runs.
    // Dispatch the post-approval hook here so the ARC floats in the same request.
    if (result.auto_approved) {
      await dispatchPostApprovalAction(result.approval_instance_id, userId, {
        status: 'APPROVED', comment: 'Auto-approved — publisher is the configured approver',
      });
      const arcNow = await arcModel.getById(id);
      const didFloat = arcNow?.status === 'floated';
      // vendor_count parity with the (former) direct-float response, so callers
      // that show "floated to N vendors" keep working on the auto-approve path.
      const floatedInvites = didFloat ? await arcModel.listInvitations(id) : [];
      return ok(res, {
        arc: arcNow,
        approval_instance_id: result.approval_instance_id,
        floated: didFloat,
        vendor_count: floatedInvites.length,
      }, didFloat ? 'ARC floated' : 'ARC publish auto-approved but could not float');
    }

    return ok(res, {
      arc: { ...arc, status: 'pending_publish_approval' },
      approval_instance_id: result.approval_instance_id,
      floated: false,
    }, 'Submitted for publish approval');
  } catch (err) {
    // A no-policy (or any pre-mapped) failure surfaces its actionable message
    // with the intended HTTP status; the throw rolled the tx back so the ARC
    // stays draft/publish_rejected.
    if (err.httpStatus) return bad(res, err.httpStatus, err.message);
    logger.error({ err }, '[arcController.publish]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// Publish-approval post-action hooks (registered in approvalActionService
// under entity_type ARC_PUBLISH). Mirror the ARC_TECH/ARC_COMMITTEE hooks.
// ============================================================

/**
 * APPROVED → float the ARC live. floatArc RE-CHECKS the vendor panel at
 * approval time; if empty (eligibility changed since publish) we do NOT float
 * to nobody — the ARC is parked as publish_rejected instead. Vendor
 * notifications fire ONLY here, AFTER the commit, and only when we floated.
 */
export async function handleArcPublishApproval(approvalInstanceId, approverUserId, options = {}) {
  try {
    const arcId = options.instance?.entity_id;
    if (!arcId) return;
    const arc = await arcModel.getById(arcId);
    if (!arc) return;
    // Idempotency: only act while still pending. Auto-approve + a later generic
    // action could both fire; the second is a no-op.
    if (arc.status !== 'pending_publish_approval') return;

    let floatResult;
    await db.tx(async (t) => {
      floatResult = await floatArc(arcId, approverUserId, { txContext: t });
      if (!floatResult.floated) {
        // Empty panel at approval time — never float to nobody; park rejected.
        await arcModel.setStatus(arcId, 'publish_rejected', { closed_reason: 'No eligible vendors at approval time' }, t);
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.PUBLISH_REJECTED, actorId: approverUserId,
          payload: { reason: 'no_vendors_at_approval', approval_instance_id: approvalInstanceId }, txContext: t,
        });
      }
    });
    // Vendor notify AFTER commit (only when we actually floated).
    if (floatResult?.floated) {
      // Sr 27 (Option C): defer the vendor "it's open for quotes" notification
      // when the submission window has not started yet — a vendor must not be
      // told a rate contract is open before submission_start_at. The ARC
      // submission-open sweep (arcSubmissionOpenService.js) fires this exact
      // notification (+ logs SUBMISSION_OPENED) once the start passes.
      // Immediate float (no start, or start already <= now) still notifies
      // right away, same as before this change, and is marked notified here.
      if (!windowNotOpen(floatResult._notifyArc)) {
        await notifyVendorsOfFloat(floatResult._notifyArc, floatResult.invitations, floatResult._actorId);
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.SUBMISSION_OPENED, actorId: floatResult._actorId, payload: {},
        });
      }
      // Notify creator that their ARC is live (publish_approved = creator BOTH).
      await notifyArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.PUBLISH_APPROVED,
        actorId: approverUserId,
        payload: { approval_instance_id: approvalInstanceId },
      });
      // Also send creator in-app "your rate contract is live" (floated event).
      await notifyArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.PUBLISHED,
        actorId: approverUserId,
        payload: {},
      });
    } else {
      logger.warn({ arcId, approvalInstanceId }, '[arcController.handleArcPublishApproval] empty panel at approval — parked publish_rejected');
    }
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[arcController.handleArcPublishApproval]');
  }
}

/** REJECTED → not live; the creator may revise + re-publish (fresh instance). */
export async function handleArcPublishRejection(approvalInstanceId, approverUserId, options = {}) {
  try {
    const arcId = options.instance?.entity_id;
    if (!arcId) return;
    const reason = options.comment || '';
    await db.tx(async (t) => {
      await arcModel.setStatus(arcId, 'publish_rejected', { closed_reason: reason || null }, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.PUBLISH_REJECTED, actorId: approverUserId,
        payload: { reason, approval_instance_id: approvalInstanceId }, txContext: t,
      });
    });
    // Notify creator — post-commit
    await notifyArcEvent({
      arcId,
      eventType: ARC_EVENT_TYPES.PUBLISH_REJECTED,
      actorId: approverUserId,
      payload: { reason },
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[arcController.handleArcPublishRejection]');
  }
}

// ============================================================
// POST /v1/arc-v2/:id/publish-approval/decide
//   Body: { decision:'approve'|'reject', comment? }
//   Engine-gated: executeApprovalAction validates the caller is the current
//   pending approver and fires the ARC_PUBLISH hooks on the terminal state.
//   Mirrors decideCommittee / decideTechEval.
// ============================================================
export async function publishApprovalDecide(req, res) {
  try {
    const arcId    = Number(req.params.id);
    const userId   = req.user?.id;
    const decision = String(req.body?.decision || '').trim();
    const comment  = req.body?.comment ? String(req.body.comment) : null;

    if (!arcId)  return bad(res, 400, 'id is required');
    if (!userId) return bad(res, 401, 'Authentication required');
    if (decision !== 'approve' && decision !== 'reject') {
      return bad(res, 400, "decision must be 'approve' or 'reject'");
    }
    if (decision === 'reject' && !comment) {
      return bad(res, 400, 'A reason (comment) is required when rejecting');
    }

    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (!instance) return bad(res, 404, 'No publish-approval instance for this ARC', 2);
    if (instance.status !== 'PENDING') {
      return bad(res, 400, `Publish approval is already ${instance.status} — no further actions allowed`);
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
    logger.error({ err }, '[arcController.publishApprovalDecide]');
    const msg = err.message || 'Internal error';
    const code = /not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step/i.test(msg) ? 400 : 500;
    return bad(res, code, msg, code === 500 ? 3 : 0);
  }
}

// ============================================================
// GET /v1/arc-v2/:id/publish-approval
//   Latest ARC_PUBLISH instance chain detail (or null) so the Overview can
//   render the approver matrix. Mirrors committee's getCommitteeView approval
//   block / tech's getTechEvalApproval.
// ============================================================
export async function getPublishApproval(req, res) {
  try {
    const arcId = Number(req.params.id);
    // Tenant isolation: the chain detail carries the full approver matrix —
    // names, emails and comments of another company's staff — over sequential
    // ids. Gate on the ARC's OWN scope before touching the instance. 404 when
    // the ARC does not exist, 403 when it does but is out of scope (mirrors
    // requireArcPermission, so existence is not leaked differently here).
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }
    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (!instance) return ok(res, { approval: null });
    const approval = await getApprovalInstanceDetails(instance.id, req.user?.id || null).catch((detailErr) => {
      logger.warn({ detailErr, instanceId: instance.id }, '[arcController.getPublishApproval] detail load failed');
      return null;
    });
    return ok(res, { approval });
  } catch (err) {
    logger.error({ err }, '[arcController.getPublishApproval]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function withdraw(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    if (arc.created_by !== userId) return bad(res, 403, 'Only the creator can withdraw');
    if (!['floated','submission_closed','pending_publish_approval'].includes(arc.status)) {
      return bad(res, 409, `Cannot withdraw ARC in status ${arc.status}`);
    }

    // A pending publish approval must cancel its PENDING ARC_PUBLISH instance
    // before returning to draft. cancelApprovalInstance opens its OWN tx (it is
    // not txContext-aware), so cancel BEFORE the status-flip tx below.
    if (arc.status === 'pending_publish_approval') {
      const inst = await db.oneOrNone(
        `SELECT id FROM tbl_approval_instances
          WHERE entity_type = 'ARC_PUBLISH' AND entity_id = $1 AND status = 'PENDING'
          ORDER BY created_at DESC LIMIT 1`,
        [id]
      );
      if (inst) {
        await cancelApprovalInstance(inst.id, userId, 'Publish withdrawn by creator');
      }
    }

    // Respond-AFTER-commit: return the updated row from the tx and send the HTTP
    // response only once it has committed. Responding inside db.tx() races the
    // COMMIT, so a client (or a test on a second connection) that re-reads the
    // ARC immediately can still see the pre-commit status. Mirrors terminate().
    const updated = await db.tx(async (t) => {
      const u = await arcModel.setStatus(id, 'draft', {}, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.WITHDRAWN,
        actorId: userId, payload: { previous_status: arc.status },
        txContext: t,
      });
      return u;
    });
    ok(res, { arc: updated }, 'ARC withdrawn back to draft');
    // Notify invited vendors post-commit
    await notifyArcEvent({ arcId: id, eventType: ARC_EVENT_TYPES.WITHDRAWN, actorId: userId, payload: {} });
  } catch (err) {
    logger.error({ err }, '[arcController.withdraw]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function terminate(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const reason = req.body?.reason;
    if (!reason) return bad(res, 400, 'reason is required');
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    // Security-first (audit C4 pattern — mirrors createDraft/updateDraft/publish):
    // reload-and-verify the ARC belongs to a hotel the caller can act on before
    // mutating it. Without this the :id path param alone would let any
    // authenticated buyer terminate another tenant's rate contract (IDOR).
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract');
    }
    // Respond-AFTER-commit: return the updated row from the tx and send the HTTP
    // response only once the transaction has committed. Sending inside db.tx()
    // races the commit — under connection-pool contention a follow-up read can
    // miss the write (see arc.draft.persistence flake). Mirrors the verifyOtp /
    // clarification respond-after-commit fixes.
    const updated = await db.tx(async (t) => {
      const u = await arcModel.setStatus(id, 'terminated', { closed_reason: reason }, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.TERMINATED,
        actorId: userId, payload: { reason, previous_status: arc.status },
        txContext: t,
      });
      return u;
    });
    ok(res, { arc: updated }, 'ARC terminated');
    // Notify awarded vendors (or invited if none) — best-effort, post-commit and
    // post-response, so a notification failure can never affect the committed
    // termination or the HTTP response.
    notifyArcEvent({ arcId: id, eventType: ARC_EVENT_TYPES.TERMINATED, actorId: userId, payload: {} })
      .catch((e) => logger.error({ err: e }, '[arcController.terminate] notify failed'));
  } catch (err) {
    logger.error({ err }, '[arcController.terminate]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// POST /:id/extend-submission — buyer "Extend submission deadline" (Sr 40).
// Lets the creator (or an authorized arc-comm evaluator) push the submission
// window out AFTER it has passed — pre-evaluation only. Reopens a
// 'submission_closed' ARC back to 'floated' so submitQuote's status + window
// guards (arcVendorController.js:617/:621) both pass again, and re-notifies
// every invited vendor (email + in-app), mirroring the float notify.
// ============================================================
export async function extendSubmission(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    if (!id) return bad(res, 400, 'id is required');
    if (!userId) return bad(res, 401, 'Authentication required');

    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);

    // Tenant guard — reload-and-verify, never trust the :id param alone
    // (security-first; mirrors getById/publish/terminate).
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }

    // Authorization: the ORIGINAL CREATOR may always extend their own ARC
    // (even if they hold no arc-comm.* module role); otherwise the caller
    // must hold arc-comm.evaluate or arc.admin in THIS ARC's own hotel/
    // department scope — resolved server-side, never trusted from the client
    // (same lookup getLifecycle/requireArcPermission use).
    const isCreator = Number(arc.created_by) === Number(userId);
    const isSuperAdmin = Number(req.user?.user_type) === 8;
    let authorized = isCreator || isSuperAdmin;
    if (!authorized && arc.hotel_id != null) {
      const rows = await rbacModel.getUserPermissionsForHotels(
        userId, [arc.hotel_id], null, arc.department_id || null
      );
      const held = new Set((rows || []).map((r) => `${r.resource}.${r.action}`));
      authorized = held.has('arc-comm.evaluate') || held.has('arc.admin');
    }
    if (!authorized) {
      return bad(res, 403, 'Only the creator or an authorized commercial evaluator can extend the submission deadline', 3);
    }

    // Status gate — pre-evaluation only (user-confirmed scope). Blocks
    // tech_eval_*, comm_eval_*, committee/award, and every later status.
    if (!['floated', 'submission_closed'].includes(arc.status)) {
      return bad(res, 409, `Deadline can only be extended before evaluation begins (current status: ${arc.status})`);
    }

    // Validation — parse as IST wall-clock (arcMomentIst; never new Date(),
    // which would shift the boundary on a UTC production runtime) and
    // require strictly future relative to IST now.
    const raw = req.body?.submission_end_at;
    if (raw == null || typeof raw !== 'string' || !raw.trim()) {
      return bad(res, 400, 'submission_end_at is required');
    }
    const newEnd = arcMomentIst(raw);
    if (!newEnd || !newEnd.isValid()) {
      return bad(res, 400, 'submission_end_at is not a valid date/time');
    }
    if (!newEnd.isAfter(nowIst())) {
      return bad(res, 400, 'New deadline must be in the future');
    }
    // Extend-only: the new deadline must be LATER than the current one. This action
    // extends/re-opens the window — it must never silently SHORTEN it and cut off
    // vendors who were relying on the original deadline.
    const curEnd = arc.submission_end_at ? arcMomentIst(arc.submission_end_at) : null;
    if (curEnd && curEnd.isValid() && !newEnd.isAfter(curEnd)) {
      return bad(res, 400, 'The new deadline must be later than the current deadline — you can only extend the submission window, not shorten it');
    }

    const previousStatus = arc.status;
    const previousEnd = arc.submission_end_at;
    const reopened = previousStatus === 'submission_closed';

    let updatedArc;
    await db.tx(async (t) => {
      // Persist the raw wall-clock string VERBATIM — same IST-naive
      // convention as createDraft/updateDraft; no new Date() round-trip.
      updatedArc = await arcModel.extendSubmissionWindow(id, raw, { reopen: reopened }, t);
      await logArcEvent({
        arcId: id, eventType: ARC_EVENT_TYPES.EXTENDED, actorId: userId,
        payload: { previous_end: previousEnd, new_end: raw, reopened, previous_status: previousStatus },
        txContext: t,
      });
    });

    // Post-commit, best-effort: re-notify every invited vendor (email + in-app)
    // via the existing central fan-out (mirrors the float notify — audit C2
    // pattern). A dispatch failure must never undo the extension.
    await notifyArcEvent({
      arcId: id, eventType: ARC_EVENT_TYPES.EXTENDED, actorId: userId,
      payload: { newDeadline: newEnd.format('DD MMM YYYY, hh:mm A') },
    });
    // Respond AFTER commit (was inside the tx before).
    return ok(res, { arc: updatedArc },
      reopened ? 'Submission deadline extended — the window is open again' : 'Submission deadline extended');
  } catch (err) {
    logger.error({ err }, '[arcController.extendSubmission]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Fine-grained ARC status → display bucket (mirrors the FE statusBucket so the
// server-side list view groups/filters identically to the old client logic).
function arcStatusBucket(s) {
  if (!s || s === 'draft' || s === 'pending_publish_approval' || s === 'publish_rejected') return 'draft';
  if (s === 'floated' || s === 'submission_closed') return 'floated';
  if (['tech_eval_in_progress', 'tech_eval_approved', 'tech_eval_rejected', 'comm_eval_in_progress'].includes(s)) return 'eval';
  if (['comm_eval_finalized', 'committee_review', 'committee_sent_back'].includes(s)) return 'committee';
  if (['committee_approved', 'contract_generated', 'awaiting_vendor_acceptance'].includes(s)) return 'awaiting';
  if (s === 'contract_active') return 'active';
  if (s === 'expiring_soon') return 'expiring';
  if (['expired', 'terminated', 'closed_no_award', 'committee_rejected'].includes(s)) return 'expired';
  return 'draft';
}
const ARC_TAB_BUCKETS = {
  drafts: ['draft'], ongoing: ['floated', 'eval', 'committee'], approved: ['awaiting'],
  active: ['active', 'expiring'], ended: ['expired'],
};

// Server-authoritative listing — search / facet / sort / paginate + the
// "Pending for me" tab, all server-side. Mirrors rfqController.getRfqListView;
// reuses the same action-stamping (approvals + open eval windows) as list().
export async function getArcListView(req, res) {
  try {
    const companyIds = await resolveHospitalityCompanyScope(req);
    const body = req.body || {};
    const tab = ['all', 'pending', 'drafts', 'ongoing', 'approved', 'active', 'ended'].includes(body.tab) ? body.tab : 'all';
    const search = (body.search || '').toString().trim().toLowerCase() || null;
    const sort = ['recent', 'value', 'expiry'].includes(body.sort) ? body.sort : 'recent';
    const page = Number(body.page) > 0 ? Number(body.page) : 1;
    const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : 20;
    const f = body.filters || {};
    const asStrArr = (v) => (Array.isArray(v) ? v.map(String) : []);
    // Accept an ISO calendar date "YYYY-MM-DD"; ignore anything else (never throw).
    const asISODate = (v) => {
      if (typeof v !== 'string') return null;
      const s = v.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };
    const filters = {
      status: asStrArr(f.status), buId: asStrArr(f.buId), categoryId: asStrArr(f.categoryId),
      departmentId: asStrArr(f.departmentId), productId: asStrArr(f.productId), vendorId: asStrArr(f.vendorId),
      dateFrom: asISODate(f.dateFrom),
      dateTo: asISODate(f.dateTo),
    };

    // 1. fetch the full scoped set (big cap so faceting is complete).
    //    scope_user_id applies the caller's 4-axis RBAC matrix. Everything
    //    downstream — rows, tab_counts (step 3) and the facet maps (step 5),
    //    including buId — is derived from THIS array, so scoping it here is what
    //    keeps a facet from enumerating an inaccessible hotel with an exact count.
    const result = await arcModel.list({
      hospitality_company_ids: companyIds,
      scope_user_id: arcScopeUserId(req),
      statusGroup: 'all',
      page: 1,
      limit: 1000,
    });
    const rows = Array.isArray(result.data) ? result.data : [];

    // 2. action stamping (approval waiting on me OR open eval window) + bucket.
    if (rows.length > 0 && req.user?.id) {
      const pendingIds = new Set(await arcModel.getPendingForUserArcIds(rows.map((r) => r.id), req.user.id));
      const evalIds = await computeArcEvalActionIds(req, rows);
      rows.forEach((r) => {
        const approval = pendingIds.has(Number(r.id));
        const techEval = evalIds.has(Number(r.id)) && (r.status === 'tech_eval_in_progress' || r.status === 'tech_eval_rejected');
        const commEval = evalIds.has(Number(r.id)) && r.status === 'comm_eval_in_progress';
        r.action_required = approval || techEval || commEval;
        r.pending_for_user = r.action_required;
        r.action_label = approval ? 'Approval needed' : techEval ? 'Technical evaluation' : commEval ? 'Commercial evaluation' : null;
        r._bucket = arcStatusBucket(r.status);
      });
    } else {
      rows.forEach((r) => { r.pending_for_user = false; r.action_required = false; r.action_label = null; r._bucket = arcStatusBucket(r.status); });
    }

    const parseArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } })() : []));
    const pairs = (ids, names) => { const a = parseArr(ids); const b = parseArr(names); const out = []; a.forEach((id, i) => { if (id != null) out.push({ id: String(id), label: b[i] != null ? String(b[i]) : `#${id}` }); }); return out; };
    const prodPairs = (r) => pairs(r.product_variant_ids, r.item_names);
    const vendPairs = (r) => pairs(r.awarded_vendor_ids, r.awarded_vendor_names);

    // 3. tab counts.
    const tab_counts = { all: rows.length, pending: 0, drafts: 0, ongoing: 0, approved: 0, active: 0, ended: 0 };
    for (const r of rows) {
      if (r.pending_for_user) tab_counts.pending++;
      for (const [t, buckets] of Object.entries(ARC_TAB_BUCKETS)) if (buckets.includes(r._bucket)) tab_counts[t]++;
    }

    // 4. tab scope.
    const tabRows = tab === 'all' ? rows
      : tab === 'pending' ? rows.filter((r) => r.pending_for_user)
      : rows.filter((r) => (ARC_TAB_BUCKETS[tab] || []).includes(r._bucket));

    // 5. facets over tab scope.
    const fm = { status: new Map(), buId: new Map(), categoryId: new Map(), departmentId: new Map(), productId: new Map(), vendorId: new Map() };
    const bump = (m, key, label) => { if (key == null || key === '') return; const e = m.get(key) || { key, label: label || null, count: 0 }; e.count++; if (label && !e.label) e.label = label; m.set(key, e); };
    const BUCKET_LABEL = { draft: 'Draft', floated: 'Floated', eval: 'In Evaluation', committee: 'Committee Review', awaiting: 'Awaiting Vendor', active: 'Active', expiring: 'Expiring Soon', expired: 'Ended' };
    for (const r of tabRows) {
      bump(fm.status, r._bucket, BUCKET_LABEL[r._bucket] || r._bucket);
      if (r.hotel_id != null) bump(fm.buId, String(r.hotel_id), r.hotel_name || `Hotel ${r.hotel_id}`);
      if (r.category_id != null) bump(fm.categoryId, String(r.category_id), r.category_title || `Category ${r.category_id}`);
      if (r.department_id != null) bump(fm.departmentId, String(r.department_id), r.department_title || `Dept ${r.department_id}`);
      for (const p of prodPairs(r)) bump(fm.productId, p.id, p.label);
      for (const v of vendPairs(r)) bump(fm.vendorId, v.id, v.label);
    }
    const toFacet = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count);
    const facets = {
      status: toFacet(fm.status), buId: toFacet(fm.buId), categoryId: toFacet(fm.categoryId),
      departmentId: toFacet(fm.departmentId), productId: toFacet(fm.productId), vendorId: toFacet(fm.vendorId),
    };

    // FY / custom-range window (epoch ms). Inclusive of both calendar days.
    const fromMs = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
    const toMs = filters.dateTo ? (new Date(`${filters.dateTo}T00:00:00`).getTime() + 86400000) : null; // exclusive upper

    // 6. facet + search filtering.
    const filtered = tabRows.filter((r) => {
      if (filters.status.length && !filters.status.includes(r._bucket)) return false;
      if (filters.buId.length && !filters.buId.includes(String(r.hotel_id))) return false;
      if (filters.categoryId.length && !filters.categoryId.includes(String(r.category_id))) return false;
      if (filters.departmentId.length && !filters.departmentId.includes(String(r.department_id))) return false;
      if (filters.productId.length && !prodPairs(r).some((p) => filters.productId.includes(p.id))) return false;
      if (filters.vendorId.length && !vendPairs(r).some((v) => filters.vendorId.includes(v.id))) return false;
      if (search) {
        const hay = `${r.title || ''} ${r.arc_number || ''} ${r.category_title || ''} ${r.hotel_name || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      // FY / custom creation-date window (server-authoritative; AND with other facets).
      if (fromMs != null || toMs != null) {
        const c = new Date(r.created_at || 0).getTime();
        if (fromMs != null && c < fromMs) return false;
        if (toMs != null && c >= toMs) return false;
      }
      return true;
    });

    // 7. sort.
    const ORDER = { expiring: 0, active: 1, eval: 2, committee: 3, awaiting: 4, floated: 5, draft: 6, expired: 7 };
    const ts = (r) => new Date(r.created_at || 0).getTime();
    if (sort === 'expiry') filtered.sort((a, b) => (ORDER[a._bucket] ?? 9) - (ORDER[b._bucket] ?? 9));
    else if (sort === 'value') filtered.sort((a, b) => Number(b.committed_value || 0) - Number(a.committed_value || 0));
    else filtered.sort((a, b) => ts(b) - ts(a));

    // 8. paginate (rows are returned whole — they carry every field the rich
    //    card renders: awarded_vendors, committed/consumed value, amendments…).
    const total = filtered.length;
    const data = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    return ok(res, { rows: data, facets, tab_counts, total, page, limit });
  } catch (err) {
    logger.error({ err }, '[arcController.getArcListView]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Of the given rows, which ARCs are in an open evaluation window that the
// current user can actually act on (i.e. holds arc-tech.evaluate /
// arc-comm.evaluate / arc.admin for the ARC's hotel + department)? Super admins
// can act on all. Permissions are resolved once per distinct hotel:department.
async function computeArcEvalActionIds(req, rows) {
  const ids = new Set();
  const TECH = new Set(['tech_eval_in_progress', 'tech_eval_rejected']);
  const COMM = new Set(['comm_eval_in_progress']);
  const candidates = rows.filter((r) => TECH.has(r.status) || COMM.has(r.status));
  if (candidates.length === 0) return ids;
  if (Number(req.user?.user_type) === 8) {
    candidates.forEach((r) => ids.add(Number(r.id)));
    return ids;
  }
  const cache = new Map();
  // Keyed on all three axes the ARC row carries — getUserPermissionsForHotels
  // filters company × hotel × department only, so the process axis is applied
  // here (same strict semantics as arcPermission + the listing predicate).
  const permsFor = async (hotelId, deptId, processId) => {
    const key = `${hotelId}:${deptId ?? ''}:${processId ?? ''}`;
    if (cache.has(key)) return cache.get(key);
    const list = await rbacModel.getUserPermissionsForHotels(req.user.id, [hotelId], null, deptId || null);
    const set = new Set(filterRowsByProcessAxis(list, processId).map((p) => `${p.resource}.${p.action}`));
    cache.set(key, set);
    return set;
  };
  for (const r of candidates) {
    if (!r.hotel_id) continue;
    const perms = await permsFor(r.hotel_id, r.department_id, r.process_id);
    const canTech = perms.has('arc-tech.evaluate') || perms.has('arc.admin');
    const canComm = perms.has('arc-comm.evaluate') || perms.has('arc.admin');
    if ((TECH.has(r.status) && canTech) || (COMM.has(r.status) && canComm)) {
      ids.add(Number(r.id));
    }
  }
  return ids;
}

export async function list(req, res) {
  try {
    const { hotel_ids, department_ids, statusGroup, page, limit } = req.query;
    // Scope to ALL the user's companies (super admin → null = all) so multi-
    // company users see their ARCs; the in-page Business Unit facet narrows.
    const companyIds = await resolveHospitalityCompanyScope(req);
    const result = await arcModel.list({
      hospitality_company_ids: companyIds,
      // Company membership alone is NOT scope — a hotel-level mapping expands
      // to the whole company. The RBAC matrix is the authority; the client's
      // hotel_ids/department_ids only narrow within it.
      scope_user_id:  arcScopeUserId(req),
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
      statusGroup: statusGroup || 'all',
      page:  Number(page || 1),
      limit: Number(limit || 20),
    });
    // Stamp "does this ARC need the current user's action?" so the listing can
    // both offer a "Pending for me" tab and highlight rows — without a second
    // round-trip. Action = an approval waiting on me (tech/committee/amendment)
    // OR an open evaluation window I'm an evaluator for.
    const rows = Array.isArray(result.data) ? result.data : [];
    if (rows.length > 0 && req.user?.id) {
      const pendingIds = new Set(
        await arcModel.getPendingForUserArcIds(rows.map((r) => r.id), req.user.id)
      );
      const evalIds = await computeArcEvalActionIds(req, rows);
      rows.forEach((r) => {
        const approval = pendingIds.has(Number(r.id));
        const techEval = evalIds.has(Number(r.id)) && (r.status === 'tech_eval_in_progress' || r.status === 'tech_eval_rejected');
        const commEval = evalIds.has(Number(r.id)) && r.status === 'comm_eval_in_progress';
        r.action_required = approval || techEval || commEval;
        r.pending_for_user = r.action_required; // the "Pending for me" tab tracks the same signal
        r.action_label = approval ? 'Approval needed'
          : techEval ? 'Technical evaluation'
          : commEval ? 'Commercial evaluation'
          : null;
      });
    } else {
      rows.forEach((r) => { r.pending_for_user = false; r.action_required = false; r.action_label = null; });
    }
    return ok(res, result);
  } catch (err) {
    logger.error({ err }, '[arcController.list]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getById(req, res) {
  try {
    const id = Number(req.params.id);
    const arc = await arcModel.getById(id);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    // Tenant scope: the detail payload carries commercial + tech-eval config
    // (clauses/weights/min-pass), so it must not be cross-tenant readable.
    // Mirror createDraft/publish — derive access from req.user (super-admin
    // bypass), never trust the id alone. A valid policy approver is always
    // hotel/company-mapped, so they retain read access.
    if (!(await userCanAccessHotel(req, arc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }
    const [items, invitations, techEvalByItem] = await Promise.all([
      arcModel.listItems(id),
      arcModel.listInvitations(id),
      arcModel.listTechEvalForArc(id),
    ]);
    // Attach the per-item tech-eval CONFIG (min-pass + clauses) so the create
    // wizard's Tech step rehydrates from this single round-trip on draft resume.
    // Additive: items[].tech_eval is null when no config exists for that item.
    for (const it of items) {
      it.tech_eval = techEvalByItem[String(it.id)] || null;
    }
    return ok(res, { arc, items, invitations });
  } catch (err) {
    logger.error({ err }, '[arcController.getById]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// GET /v1/arc-v2/:id/lifecycle — the single authoritative page's spine.
// Returns the computed stage states + the caller's ARC permissions, both
// derived from the ARC row's own scope (hotel/department) — never from
// client headers. Lazily flips floated→submission_closed once the window
// has passed (idempotent, event-logged).
// ============================================================
const ARC_PERMISSION_RESOURCES = ['arc', 'arc-tech', 'arc-comm', 'arc-committee'];
const ARC_ALL_ACTIONS = {
  'arc':           ['read', 'create', 'admin'],
  'arc-tech':      ['read', 'evaluate'],
  'arc-comm':      ['read', 'evaluate'],
  'arc-committee': ['read', 'approve'],
};

export async function getLifecycle(req, res) {
  try {
    const id = Number(req.params.id);
    const userId = req.user?.id;
    const lifecycle = await arcLifecycleModel.computeLifecycle(id, { userId, lazyFlip: true, withActors: true });
    if (!lifecycle) return bad(res, 404, 'ARC not found', 2);
    // Tenant guard — the lifecycle now carries approver/evaluator PII (names,
    // emails, mobiles), so it must not be cross-tenant readable. Mirror getById.
    if (!(await userCanAccessHotel(req, lifecycle.arc))) {
      return bad(res, 403, 'You do not have access to this rate contract', 3);
    }

    // Caller's ARC permissions in THIS ARC's scope. Super admin sees all.
    let permissions;
    if (Number(req.user?.user_type) === 8) {
      permissions = { ...ARC_ALL_ACTIONS };
    } else {
      permissions = Object.fromEntries(ARC_PERMISSION_RESOURCES.map((r) => [r, []]));
      if (lifecycle.arc.hotel_id != null) {
        const rows = filterRowsByProcessAxis(
          await rbacModel.getUserPermissionsForHotels(
            userId, [lifecycle.arc.hotel_id], null, lifecycle.arc.department_id || null
          ),
          lifecycle.arc.process_id
        );
        for (const row of rows) {
          const resource = String(row.resource);
          if (permissions[resource]) permissions[resource].push(String(row.action));
        }
      }
    }

    return ok(res, { ...lifecycle, permissions });
  } catch (err) {
    logger.error({ err }, '[arcController.getLifecycle]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function dashboardCounts(req, res) {
  try {
    const { hotel_ids, department_ids } = req.query;
    const companyIds = await resolveHospitalityCompanyScope(req);
    const counts = await arcModel.dashboardCounts({
      hospitality_company_ids: companyIds,
      scope_user_id:  arcScopeUserId(req),
      hotel_ids:      hotel_ids      ? String(hotel_ids).split(',').map(Number)      : null,
      department_ids: department_ids ? String(department_ids).split(',').map(Number) : null,
    });
    return ok(res, { counts });
  } catch (err) {
    logger.error({ err }, '[arcController.dashboardCounts]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getDepartmentsForCategory(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    const userId     = req.user?.id;
    // The company is SERVER-derived: resolveHospitalityCompanyId honours a
    // client hint only when the caller is actually mapped to that company, so a
    // spoofed hospitality_company_id can never widen the answer.
    const hcId       = await resolveHospitalityCompanyId(req);
    if (!categoryId || !userId || !hcId) {
      return bad(res, 400, 'category_id, user, and hospitality_company_id are required');
    }
    // Optional BU narrowing — once the wizard has a hotel, only departments the
    // caller is scoped to AT THAT HOTEL may be offered. Without it, a user
    // scoped proc@A1 + eng@A2 was offered {proc, eng} for either hotel.
    const hotelId = Number(req.query.hotel_id) || null;
    if (hotelId && !(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel', 3);
    }
    const departments = await arcModel.getDepartmentsForCategoryAndUser({
      category_id: categoryId,
      user_id: userId,
      hospitality_company_id: hcId,
      hotel_id: hotelId,
    });
    return ok(res, { departments });
  } catch (err) {
    logger.error({ err }, '[arcController.getDepartmentsForCategory]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Departments the current user is mapped to in a given hotel (drives the ARC
// create department picker — independent of the category→department mapping).
export async function getDepartmentsForHotel(req, res) {
  try {
    const hotelId = Number(req.query.hotel_id);
    const userId  = req.user?.id;
    if (!hotelId || !userId) return bad(res, 400, 'hotel_id is required', 2);
    // Super admins have no role-scope rows to derive from → every department.
    if (Number(req.user?.user_type) === 8) {
      const all = await db.any('SELECT id, title FROM tbl_department ORDER BY title');
      return ok(res, { departments: all });
    }
    const departments = await arcModel.getDepartmentsForUserInHotel({ user_id: userId, hotel_id: hotelId });
    return ok(res, { departments });
  } catch (err) {
    logger.error({ err }, '[arcController.getDepartmentsForHotel]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function getSubCategories(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    if (!categoryId) return bad(res, 400, 'category_id is required');
    const rows = await db.any(
      `SELECT id, title FROM tbl_category WHERE parent_id = $1 AND COALESCE(is_deleted, 0) = 0 ORDER BY title`,
      [categoryId]
    );
    return ok(res, { sub_categories: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.getSubCategories]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns the top-level categories (parent_id NULL or 0) for the wizard.
export async function listRootCategories(req, res) {
  try {
    const rows = await db.any(
      `SELECT id, title
         FROM tbl_category
        WHERE (parent_id IS NULL OR parent_id = 0)
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY title`
    );
    return ok(res, { categories: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listRootCategories]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns the user's accessible hotels for the BU picker.
export async function listAccessibleHotels(req, res) {
  try {
    // A picker must show hotels across ALL the user's companies — otherwise a
    // multi-company user can't select (and so can't act on) a hotel in any
    // company but their lowest-id one. Super admin (null) → all companies.
    const companyIds = await resolveHospitalityCompanyScope(req);
    // …but "the user's companies" is not the same as "the user's hotels": one
    // company-level mapping row used to list every BU in the company, so this
    // picker enumerated hotels the caller has no grant on. Narrow to the RBAC
    // matrix — a scope row with hotel_id NULL still means "every hotel in that
    // company", so company-wide admins are unaffected.
    const scope = buildArcScopeClause(arcScopeUserId(req), {
      company: 'h.hospitality_company_id',
      hotel: 'h.id',
    }, 2);
    const rows = await db.any(
      `SELECT h.id, h.hospitality_company_id, h.name, h.city, h.keys
         FROM tbl_hospitality_company_hotels h
        WHERE ($1::int[] IS NULL OR h.hospitality_company_id = ANY($1::int[]))
          AND COALESCE(h.is_deleted, 0) = 0
          AND ${scope.clause}
        ORDER BY h.name`,
      [companyIds && companyIds.length ? companyIds : (companyIds === null ? null : []), ...scope.params]
    );
    return ok(res, { hotels: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listAccessibleHotels]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns product variants belonging to a category (and optional sub-categories).
export async function searchProductVariants(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    if (!categoryId) return bad(res, 400, 'category_id is required');
    const subCatIds = req.query.sub_category_ids
      ? String(req.query.sub_category_ids).split(',').map(Number).filter(Boolean)
      : [];
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    // Server-side pagination so the wizard's catalogue picker scales to
    // categories with thousands of variants (ENGINEERING ~4k) — the client
    // loads one page at a time.
    const limit  = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const page   = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const conds  = ['COALESCE(pv.status, 1) = 1'];
    const args   = [categoryId];
    let p = 2;
    if (subCatIds.length > 0) {
      conds.push(`EXISTS (SELECT 1 FROM tbl_product_categories pcsub WHERE pcsub.product_id = pv.product_id AND pcsub.category_id = ANY($${p}::int[]))`);
      args.push(subCatIds); p++;
    }
    if (search) {
      conds.push(`(LOWER(pv.name) LIKE $${p} OR LOWER(pv.slug) LIKE $${p})`);
      args.push(search); p++;
    }
    const limitIdx = p; args.push(limit); p++;
    const offsetIdx = p; args.push(offset); p++;

    // tbl_product_variant exposes hsn_code (not hsn) and carries no unit column
    // — uom is set per-item by the ARC creator, not on the catalogue variant —
    // so we return it as null. (The previous query referenced pv.hsn / pv.unit /
    // tbl_units.title, none of which exist, so it 500'd on every call and the
    // wizard's Items step silently showed "No items match".) COUNT(*) OVER()
    // returns the full pre-pagination total for the "Load more" affordance.
    // Sr 7 root cause: a JOIN tbl_product_categories pc ON pc.product_id =
    // pv.product_id WHERE pc.category_id = $1 multiplies a variant once per
    // matching tbl_product_categories row — a product mapped more than once
    // to the same category (the known duplicate-mapping situation) yielded
    // duplicate rows and an inflated COUNT(*) OVER() total. EXISTS (mirroring
    // the sub-cat clause above) makes the category filter non-multiplying so
    // each variant appears once and the total is correct.
    const rows = await db.any(
      `SELECT pv.id, pv.name, pv.slug, pv.hsn_code AS hsn, NULL::text AS uom,
              COUNT(*) OVER()::int AS total_count
         FROM tbl_product_variant pv
        WHERE EXISTS (SELECT 1 FROM tbl_product_categories pc
                      WHERE pc.product_id = pv.product_id AND pc.category_id = $1)
          AND ${conds.join(' AND ')}
        ORDER BY pv.name
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      args
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    const variants = rows.map(({ total_count, ...r }) => r);
    return ok(res, { variants, total, page, limit });
  } catch (err) {
    logger.error({ err }, '[arcController.searchProductVariants]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// Returns vendors eligible for the (category, hotel) pair via the existing
// vendor_hotel_category_subscription table.
export async function listEligibleVendors(req, res) {
  try {
    const categoryId = Number(req.query.category_id);
    const hotelId    = Number(req.query.hotel_id);
    if (!categoryId || !hotelId) return bad(res, 400, 'category_id and hotel_id are required');
    // hotel_id arrives from the client and the response carries vendor PII
    // (name, email, mobile), so the hotel must be validated against the
    // caller's own scope — otherwise any buyer could enumerate every tenant's
    // vendor panel by walking hotel ids.
    if (!(await userCanAccessHotel(req, hotelId))) {
      return bad(res, 403, 'You do not have access to this hotel', 3);
    }
    const rows = await db.any(
      `SELECT DISTINCT u.id, u.name, u.email, u.mobile
         FROM tbl_users u
         JOIN tbl_vendor_hotel_category_subscription vhcs
           ON vhcs.vendor_id = u.id
        WHERE u.user_type = 3
          AND u.status = 1
          AND vhcs.status IN ('active', 'expired')
          AND (
            (vhcs.item_type = 'hotel'    AND vhcs.item_id = $2)
            OR
            (vhcs.item_type = 'category' AND vhcs.item_id = $1)
          )
        ORDER BY u.name`,
      [categoryId, hotelId]
    );
    return ok(res, { vendors: rows });
  } catch (err) {
    logger.error({ err }, '[arcController.listEligibleVendors]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}
