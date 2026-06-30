import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcNegotiationModel from '../../models/arc_v2/arcNegotiationModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { logger } from '../../util/logger.js';
import {
  createApprovalInstance,
  getApprovalInstancesByEntity,
  findBestMatchingPolicyTx,
} from '../../models/generalModel.js';
import { executeApprovalAction, dispatchPostApprovalAction } from '../../services/approvalActionService.js';
import {
  scheduleArcNegotiationRoundExpiration,
  removeArcNegotiationRoundExpiration,
} from '../../helper/cronManager.js';

/**
 * ARC Negotiation Controller
 *
 * Buyer + vendor handlers for the ARC negotiation sub-module.
 * Mirrors the RFQ negotiationController (negotiationController.js:516-990
 * for createRound, 1147-1315 approveRound, 1721-1801 closeRound,
 * 1847-1937 submitVendorQuote) — ARC data shapes, ARC model, no charge fields.
 *
 * Post-approval hooks at the bottom are exported and registered in
 * approvalActionService.js postActionRegistry['ARC_NEGOTIATION'].
 *
 * Security: every handler derives userId = req.user.id and ALL tenant scope
 * by reloading tbl_arc — NEVER from body/query. round.source_id === arcId
 * is verified on every mutation.
 */

function ok(res, data, message = 'success')  { return res.status(200).json({ status: 1, message, data }); }
function bad(res, status, message, code = 0) { return res.status(status).json({ status: code, message }); }
function fail(res, err, tag) {
  logger.error({ err }, tag);
  if (err.httpStatus) {
    return res.status(err.httpStatus).json({
      status: 0,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }
  return bad(res, 500, err.message || 'Internal error', 3);
}

async function resolveArcPolicy(entityType, scope, t) {
  let policy = await findBestMatchingPolicyTx({ entity_type: entityType, ...scope }, t);
  if (!policy) policy = await findBestMatchingPolicyTx({ entity_type: 'ARC', ...scope }, t);
  return policy;
}

// ============================================================
// BUYER — create round
// ============================================================

export async function createRound(req, res) {
  try {
    const arcId  = Number(req.params.arcId);
    const userId = req.user?.id;
    const body   = req.body || {};

    // ── Normalise body into entries[] (mirror negotiationController.js:521-571) ──
    let entries = [];

    if (Array.isArray(body.products) && body.products.length > 0) {
      // New multi shape: { end_date, products: [...] }
      entries = body.products;
    } else if (body.arc_item_id) {
      // Legacy single shape: { arc_item_id, vendor_ids, end_date, ... }
      entries = [{
        arc_item_id:    Number(body.arc_item_id),
        vendor_targets: (body.vendor_ids || []).map((id) => ({ vendor_id: Number(id) })),
      }];
    } else if (body.is_arc_level) {
      entries = [{
        is_arc_level:   true,
        vendor_targets: body.vendor_targets || [],
      }];
    } else {
      return bad(res, 400, 'Request must include products[] (multi-shape), arc_item_id (legacy), or is_arc_level:true');
    }

    const endDate     = body.end_date;
    const targetPrice = body.target_price || null;
    const remarks     = body.remarks     || null;

    if (!endDate || new Date(endDate) <= new Date()) {
      return bad(res, 400, 'end_date must be a future date');
    }

    // Validate: at most one arc-level entry
    const arcLevelEntries = entries.filter((e) => e.is_arc_level);
    if (arcLevelEntries.length > 1) {
      return bad(res, 400, 'Only one arc-level entry is permitted per round submission');
    }

    const result = await db.tx(async (t) => {
      // Reload ARC — scope source of truth (NEVER from body)
      const arc = await arcModel.getById(arcId, t);
      if (!arc) return bad(res, 404, 'ARC not found', 2);

      const scope = {
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
      };

      // Stage guard: comm-eval must be active/partial, not finalized
      await arcLifecycleModel.assertStageWritable(arcId, 'commercial', t, { blockLocked: true });

      // ── Validate entries ──
      // For product entries: verify arc_item_id belongs to this ARC
      const allVendorIds = new Set();
      for (const entry of entries) {
        if (entry.is_arc_level) {
          if (!Array.isArray(entry.vendor_targets) || entry.vendor_targets.length === 0) {
            return bad(res, 400, 'Arc-level entry must have at least one vendor target');
          }
          for (const vt of entry.vendor_targets) allVendorIds.add(Number(vt.vendor_id));
          // For arc-level: vendor must have a submitted, non-withdrawn quote
          for (const vt of entry.vendor_targets) {
            const vendorId = Number(vt.vendor_id);
            const quote = await t.oneOrNone(
              `SELECT id FROM tbl_arc_quote
                WHERE arc_id = $1 AND vendor_id = $2
                  AND submitted_at IS NOT NULL AND withdrawn_at IS NULL`,
              [arcId, vendorId]
            );
            if (!quote) {
              return bad(res, 400, `Vendor ${vendorId} has no submitted quote for this ARC`);
            }
          }
        } else {
          const arcItemId = Number(entry.arc_item_id);
          if (!arcItemId) return bad(res, 400, 'Product entry must have a valid arc_item_id');
          const item = await t.oneOrNone(
            `SELECT id FROM tbl_arc_item WHERE id = $1 AND arc_id = $2`,
            [arcItemId, arcId]
          );
          if (!item) return bad(res, 400, `Item ${arcItemId} does not belong to ARC ${arcId}`);
          if (!Array.isArray(entry.vendor_targets) || entry.vendor_targets.length === 0) {
            return bad(res, 400, `Item ${arcItemId} must have at least one vendor target`);
          }
          // Vendor qualification checks
          const qualifiedMap = await arcEvalModel.qualifiedVendorsByItem(arcId, t);
          for (const vt of entry.vendor_targets) {
            const vendorId = Number(vt.vendor_id);
            allVendorIds.add(vendorId);
            // invited check
            const invited = await t.oneOrNone(
              `SELECT id FROM tbl_arc_invitation WHERE arc_id = $1 AND vendor_id = $2`,
              [arcId, vendorId]
            );
            if (!invited) return bad(res, 400, `Vendor ${vendorId} is not invited to this ARC`);
            // submitted quote with a line for this item
            const line = await t.oneOrNone(
              `SELECT ql.id FROM tbl_arc_quote_line ql
                 JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
                WHERE q.arc_id = $1 AND q.vendor_id = $2
                  AND ql.arc_item_id = $3
                  AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL`,
              [arcId, vendorId, arcItemId]
            );
            if (!line) return bad(res, 400, `Vendor ${vendorId} has no submitted quote line for item ${arcItemId}`);
            // technical qualification (if clauses exist for this item)
            const allowed = qualifiedMap[arcItemId];
            if (allowed && !allowed.includes(vendorId)) {
              return bad(res, 400, `Vendor ${vendorId} is not technically qualified for item ${arcItemId}`);
            }
          }
        }
      }

      const vendorIdsArr = [...allVendorIds];

      // ── Overlap guard ──
      for (const entry of entries) {
        const arcItemId = entry.is_arc_level ? null : Number(entry.arc_item_id);
        const entryVendorIds = entry.vendor_targets.map((vt) => Number(vt.vendor_id));
        const overlap = await arcNegotiationModel.getOverlappingRound(arcId, {
          arcItemId,
          vendorIds: entryVendorIds,
        }, t);
        if (overlap) {
          const scopeLabel = entry.is_arc_level ? 'ARC-level' : `item ${entry.arc_item_id}`;
          return bad(res, 400, `A non-terminal round already exists for ${scopeLabel} (round #${overlap.round_number}). Close or wait for it to finish before creating a new one.`);
        }
      }

      // ── Policy resolution ──
      const policy = await resolveArcPolicy('ARC_NEGOTIATION', scope, t);
      if (!policy) {
        return bad(res, 400, 'No approval policy configured for ARC negotiation in this scope.');
      }

      // ── Determine persistence shape ──
      const isMultiShape = entries.length > 1 || arcLevelEntries.length > 0;
      const singleItemId = !isMultiShape ? Number(entries[0].arc_item_id) : null;
      const productsJson = isMultiShape
        ? entries.map((e) =>
            e.is_arc_level
              ? { is_arc_level: true, vendor_targets: e.vendor_targets }
              : { arc_item_id: Number(e.arc_item_id), vendor_targets: e.vendor_targets }
          )
        : null;

      const roundNumber = await arcNegotiationModel.getNextRoundNumber(arcId, t);

      const vendorApprovals = vendorIdsArr.map((vid) => ({
        vendor_id: vid,
        status:    'PENDING',
      }));

      // ── Persist round ──
      const round = await arcNegotiationModel.createRound({
        arcId,
        arcItemId:   singleItemId,
        products:    productsJson,
        endDate,
        targetPrice,
        remarks,
        createdBy:   userId,
        vendorIds:   vendorIdsArr,
        vendorApprovals,
        roundNumber,
      }, t);

      // ── Spawn approval instance ──
      const engineResult = await createApprovalInstance({
        entity_type:            'ARC_NEGOTIATION',
        entity_id:              round.id,
        hospitality_company_id: scope.hospitality_company_id,
        hotel_id:               scope.hotel_id,
        department_id:          scope.department_id,
        process_id:             scope.process_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata: {
          round_id:     round.id,
          arc_id:       arcId,
          round_number: roundNumber,
          end_date:     endDate,
        },
        txContext: t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');

      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_CREATED,
        actorId: userId,
        payload:  { round_id: round.id, round_number: roundNumber },
        txContext: t,
      });

      // Auto-approve: flip round ACTIVE inside the tx so the committed row is ACTIVE
      if (engineResult.autoApproved === true) {
        await arcNegotiationModel.updateRoundStatus(round.id, 'ACTIVE', {
          approved_at:  new Date(),
          published_at: new Date(),
        }, t);
        await arcNegotiationModel.updateAllVendorsStatus(round.id, 'APPROVED', t);
      }

      return {
        __round:        round,
        __instanceId:   instanceRow.id,
        __autoApproved: engineResult.autoApproved === true,
      };
    });

    if (result && result.__round) {
      // Schedule expiration job post-commit
      scheduleArcNegotiationRoundExpiration(result.__round);

      if (result.__autoApproved) {
        // Fire post-approval effects (vendor notifications) post-commit
        await dispatchPostApprovalAction(result.__instanceId, userId, {
          status: 'APPROVED',
          comment: 'Auto-approved — creator is the configured ARC_NEGOTIATION approver',
        });
      } else {
        await notifyArcEvent({
          arcId,
          eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_CREATED,
          actorId:   userId,
          payload:   { round_id: result.__round.id },
        });
      }
      return ok(res, result.__round, 'Negotiation round created');
    }
    return result; // propagate bad() responses from inside the tx
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.createRound]');
  }
}

// ============================================================
// BUYER — approve round
// ============================================================

export async function approveRound(req, res) {
  try {
    const arcId   = Number(req.params.arcId);
    const roundId = Number(req.params.roundId);
    const userId  = req.user?.id;
    const remarks = req.body?.remarks || req.body?.comment || null;

    const round = await arcNegotiationModel.getRoundById(roundId);
    if (!round) return bad(res, 404, 'Round not found', 2);
    if (Number(round.source_id) !== arcId || round.source_type !== 'ARC') {
      return bad(res, 403, 'Round does not belong to this ARC');
    }
    if (round.status !== 'PENDING_APPROVAL') {
      return bad(res, 400, `Cannot approve round in status '${round.status}'`);
    }

    const instances = await getApprovalInstancesByEntity('ARC_NEGOTIATION', roundId);
    const instance  = instances?.find?.((i) => i.status === 'PENDING') || instances?.[0];
    if (!instance) return bad(res, 404, 'No PENDING approval instance found for this round', 2);

    const result = await executeApprovalAction({
      approval_instance_id: instance.id,
      approver_user_id:     userId,
      action:               'APPROVE',
      comment:              remarks,
    });

    return ok(res, { allApproved: result.instance_status === 'APPROVED' }, 'Vote recorded');
  } catch (err) {
    const msg = err?.message || '';
    if (/not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step/i.test(msg)) {
      return bad(res, 400, msg);
    }
    return fail(res, err, '[arcNegotiationController.approveRound]');
  }
}

// ============================================================
// BUYER — reject round
// ============================================================

export async function rejectRound(req, res) {
  try {
    const arcId   = Number(req.params.arcId);
    const roundId = Number(req.params.roundId);
    const userId  = req.user?.id;
    const comment = req.body?.comment || req.body?.remarks || null;

    if (!comment) return bad(res, 400, 'A rejection comment is required');

    const round = await arcNegotiationModel.getRoundById(roundId);
    if (!round) return bad(res, 404, 'Round not found', 2);
    if (Number(round.source_id) !== arcId || round.source_type !== 'ARC') {
      return bad(res, 403, 'Round does not belong to this ARC');
    }
    if (round.status !== 'PENDING_APPROVAL') {
      return bad(res, 400, `Cannot reject round in status '${round.status}'`);
    }

    const instances = await getApprovalInstancesByEntity('ARC_NEGOTIATION', roundId);
    const instance  = instances?.find?.((i) => i.status === 'PENDING') || instances?.[0];
    if (!instance) return bad(res, 404, 'No PENDING approval instance found for this round', 2);

    const result = await executeApprovalAction({
      approval_instance_id: instance.id,
      approver_user_id:     userId,
      action:               'REJECT',
      comment,
    });

    return ok(res, { allRejected: result.instance_status === 'REJECTED' }, 'Vote recorded');
  } catch (err) {
    const msg = err?.message || '';
    if (/not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step/i.test(msg)) {
      return bad(res, 400, msg);
    }
    return fail(res, err, '[arcNegotiationController.rejectRound]');
  }
}

// ============================================================
// BUYER — list rounds
// ============================================================

export async function listRounds(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const rounds = await arcNegotiationModel.getRoundsForArc(arcId);

    // Compute effective status (lazy-flip)
    const enriched = rounds.map((r) => {
      let effectiveStatus = r.status;
      if (r.status === 'ACTIVE' && new Date(r.end_date) <= new Date()) {
        effectiveStatus = 'ENDED';
      }
      return { ...r, effective_status: effectiveStatus };
    });

    return ok(res, enriched);
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.listRounds]');
  }
}

// ============================================================
// BUYER — get round quotes
// ============================================================

export async function getRoundQuotes(req, res) {
  try {
    const arcId   = Number(req.params.arcId);
    const roundId = Number(req.params.roundId);

    const round = await arcNegotiationModel.getRoundById(roundId);
    if (!round) return bad(res, 404, 'Round not found', 2);
    if (Number(round.source_id) !== arcId || round.source_type !== 'ARC') {
      return bad(res, 403, 'Round does not belong to this ARC');
    }

    const quotes = await arcNegotiationModel.getRoundQuotes(roundId);
    return ok(res, { round, quotes });
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.getRoundQuotes]');
  }
}

// ============================================================
// BUYER — close round
// ============================================================

export async function closeRound(req, res) {
  try {
    const arcId   = Number(req.params.arcId);
    const roundId = Number(req.params.roundId);
    const userId  = req.user?.id;

    const round = await arcNegotiationModel.getRoundById(roundId);
    if (!round) return bad(res, 404, 'Round not found', 2);
    if (Number(round.source_id) !== arcId || round.source_type !== 'ARC') {
      return bad(res, 403, 'Round does not belong to this ARC');
    }
    if (!['ACTIVE', 'ENDED'].includes(round.status)) {
      return bad(res, 400, `Cannot close round in status '${round.status}'`);
    }

    const updated = await db.tx(async (t) => {
      const r = await arcNegotiationModel.updateRoundStatus(roundId, 'COMPLETED', {
        closed_at: new Date(),
      }, t);
      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_CLOSED,
        actorId: userId,
        payload:  { round_id: roundId, round_number: round.round_number },
        txContext: t,
      });
      return r;
    });

    removeArcNegotiationRoundExpiration(roundId);
    return ok(res, updated, 'Round closed');
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.closeRound]');
  }
}

// ============================================================
// VENDOR — list rounds
// ============================================================

export async function listVendorRounds(req, res) {
  try {
    const arcId    = Number(req.params.arcId);
    const vendorId = req.user?.id;

    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);

    const allRounds = await arcNegotiationModel.getRoundsForArc(arcId);
    // Filter to rounds where this vendor is in vendor_ids
    const myRounds = allRounds.filter(
      (r) => Array.isArray(r.vendor_ids) && r.vendor_ids.map(Number).includes(Number(vendorId))
    );

    // Enrich with per-round per-item data for this vendor
    const enriched = await Promise.all(myRounds.map(async (r) => {
      const effectiveStatus = (r.status === 'ACTIVE' && new Date(r.end_date) <= new Date()) ? 'ENDED' : r.status;
      const isActive = effectiveStatus === 'ACTIVE';

      // Determine covered item ids for this vendor in this round
      let coveredItemIds = [];
      if (r.arc_item_id) {
        coveredItemIds = [Number(r.arc_item_id)];
      } else if (r.products) {
        const prods = typeof r.products === 'string' ? JSON.parse(r.products) : r.products;
        if (prods.some((p) => p.is_arc_level)) {
          // Arc-level: all items this vendor has a quote line for
          const lines = await db.any(
            `SELECT ql.arc_item_id FROM tbl_arc_quote_line ql
               JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
              WHERE q.arc_id = $1 AND q.vendor_id = $2
                AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL`,
            [arcId, vendorId]
          );
          coveredItemIds = lines.map((l) => Number(l.arc_item_id));
        } else {
          coveredItemIds = prods.map((p) => Number(p.arc_item_id)).filter(Boolean);
        }
      }

      // Per item: current rate, rate_source, hasSubmittedQuote, target_rate
      const itemDetails = await Promise.all(coveredItemIds.map(async (itemId) => {
        const line = await db.oneOrNone(
          `SELECT ql.rate, ql.rate_source, ql.negotiated_round_id, ql.arc_item_id,
                  pv.name AS item_name
             FROM tbl_arc_quote_line ql
             JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
             JOIN tbl_arc_item ai ON ai.id = ql.arc_item_id
             LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
            WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3
              AND q.submitted_at IS NOT NULL AND q.withdrawn_at IS NULL`,
          [arcId, vendorId, itemId]
        );
        const quote = await arcNegotiationModel.getExistingRoundQuote(r.id, vendorId, itemId);
        // target_rate for this vendor from round vendor_targets
        let targetRate = null;
        if (r.products) {
          const prods = typeof r.products === 'string' ? JSON.parse(r.products) : r.products;
          for (const p of prods) {
            if (p.is_arc_level || Number(p.arc_item_id) === itemId) {
              const vt = (p.vendor_targets || []).find((v) => Number(v.vendor_id) === Number(vendorId));
              if (vt?.target_rate !== undefined) targetRate = vt.target_rate;
            }
          }
        }
        return {
          arc_item_id:        itemId,
          item_name:          line?.item_name || null,
          current_rate:       line?.rate || null,
          rate_source:        line?.rate_source || 'LANDED',
          has_submitted_quote: !!quote,
          is_active:          isActive,
          is_expired:         effectiveStatus === 'ENDED' || effectiveStatus === 'EXPIRED',
          target_rate:        targetRate,
          deadline:           r.end_date,
        };
      }));

      return {
        round_id:          r.id,
        round_number:      r.round_number,
        status:            r.status,
        effective_status:  effectiveStatus,
        end_date:          r.end_date,
        target_price:      r.target_price,
        remarks:           r.remarks,
        items:             itemDetails,
      };
    }));

    return ok(res, enriched);
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.listVendorRounds]');
  }
}

// ============================================================
// VENDOR — submit revised quote (DECISION-1 auto-apply)
// ============================================================

export async function submitVendorQuote(req, res) {
  try {
    const roundId  = Number(req.params.roundId);
    const vendorId = req.user?.id;
    const { arc_item_id, rate, gst_pct, charges } = req.body || {};

    if (!arc_item_id || rate == null) {
      return bad(res, 400, 'arc_item_id and rate are required');
    }
    const arcItemId = Number(arc_item_id);

    const round = await arcNegotiationModel.getRoundById(roundId);
    if (!round) return bad(res, 404, 'Round not found', 2);
    if (round.source_type !== 'ARC') return bad(res, 403, 'Round is not an ARC round');
    const arcId = Number(round.source_id);

    // Status guard: must be ACTIVE and not lazily-expired
    if (round.status !== 'ACTIVE') {
      return bad(res, 400, `Round is not active (status: ${round.status})`);
    }
    if (new Date(round.end_date) <= new Date()) {
      return bad(res, 400, 'Round has ended — deadline has passed');
    }

    // Vendor in round guard
    const vendorInRound = Array.isArray(round.vendor_ids) &&
      round.vendor_ids.map(Number).includes(Number(vendorId));
    if (!vendorInRound) return bad(res, 403, 'You are not a participant in this round');

    // Item coverage guard
    let itemCovered = false;
    if (round.arc_item_id && Number(round.arc_item_id) === arcItemId) {
      itemCovered = true;
    } else if (round.products) {
      const prods = typeof round.products === 'string' ? JSON.parse(round.products) : round.products;
      for (const p of prods) {
        if (p.is_arc_level) { itemCovered = true; break; }
        if (Number(p.arc_item_id) === arcItemId) { itemCovered = true; break; }
      }
    }
    if (!itemCovered) {
      return bad(res, 400, `Item ${arcItemId} is not covered by this round`);
    }

    // Duplicate submit guard (one quote per round + vendor + item)
    const existing = await arcNegotiationModel.getExistingRoundQuote(roundId, vendorId, arcItemId);
    if (existing) {
      return res.status(409).json({
        status: 0,
        message: 'You have already submitted a revised rate for this item in this round',
        code: 'DUPLICATE_SUBMIT',
      });
    }

    // Main tx: archive → round quote → update line + tag (DECISION-1)
    const txResult = await db.tx(async (t) => {
      // Get + lock the vendor's quote line FOR UPDATE
      const line = await arcNegotiationModel.getVendorQuoteLineForItem(arcId, vendorId, arcItemId, t);
      if (!line) {
        return bad(res, 403, 'You do not have a submitted quote line for this item');
      }

      // In-tx re-check (authoritative duplicate guard): the FOR UPDATE lock above
      // serialises concurrent submits. Re-querying with the tx handle `t` means
      // the second concurrent request will see the first's committed row and abort
      // cleanly — the pre-tx check above is a fast path only.
      const existingInTx = await arcNegotiationModel.getExistingRoundQuote(roundId, vendorId, arcItemId, t);
      if (existingInTx) {
        const dupErr = new Error('You have already submitted a revised rate for this item in this round');
        dupErr.httpStatus = 409;
        dupErr.code = 'DUPLICATE_SUBMIT';
        throw dupErr;
      }

      // Archive + update line
      const updatedLine = await arcNegotiationModel.applyNegotiatedRate({
        lineId:     line.id,
        oldRate:    line.rate,
        oldGstPct:  line.gst_pct,
        oldCharges: line.charges,
        rate:       Number(rate),
        gstPct:     gst_pct != null ? Number(gst_pct) : null,
        charges:    charges || null,
        roundId,
        changedBy:  vendorId,
      }, t);

      // Insert round quote record — wrapped to map the partial unique-index
      // violation (Postgres code 23505) to the same DUPLICATE_SUBMIT 409 as the
      // checks above. This is the final backstop for any gap not caught by the
      // pre-tx or in-tx checks (e.g. a retry after an unexpected error mid-tx).
      let roundQuote;
      try {
        roundQuote = await arcNegotiationModel.insertRoundQuote({
          negotiationRoundId: roundId,
          vendorId,
          arcItemId,
          quotedPrice:   Number(rate),
          previousPrice: line.rate,
        }, t);
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          const dupErr = new Error('You have already submitted a revised rate for this item in this round');
          dupErr.httpStatus = 409;
          dupErr.code = 'DUPLICATE_SUBMIT';
          throw dupErr;
        }
        throw insertErr;
      }

      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_QUOTE_RECEIVED,
        actorId: vendorId,
        payload:  { round_id: roundId, arc_item_id: arcItemId, vendor_id: vendorId, rate: Number(rate) },
        txContext: t,
      });

      return { __quote: roundQuote, __line: updatedLine };
    });

    if (txResult && txResult.__quote) {
      // Notify comm-evaluators + creator post-commit
      await notifyArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_QUOTE_RECEIVED,
        actorId:   vendorId,
        payload:   { round_id: roundId, arc_item_id: arcItemId, vendor_id: vendorId, rate: Number(rate) },
      });
      return ok(res, {
        quote: txResult.__quote,
        line:  {
          id:          txResult.__line?.id,
          rate:        txResult.__line?.rate,
          rate_source: 'NEGOTIATED',
        },
      }, 'Revised rate submitted');
    }
    return txResult;
  } catch (err) {
    return fail(res, err, '[arcNegotiationController.submitVendorQuote]');
  }
}

// ============================================================
// POST-APPROVAL HOOKS (exported, registered in approvalActionService)
// ============================================================

/**
 * Called by approvalActionService when an ARC_NEGOTIATION instance reaches APPROVED.
 * Sets round status = ACTIVE + notifies vendors.
 * Must never throw (swallow + log).
 */
export async function handleArcNegotiationApproval(approvalInstanceId, actorUserId, { instance } = {}) {
  try {
    const roundId = instance?.metadata?.round_id;
    const arcId   = instance?.metadata?.arc_id;
    if (!roundId || !arcId) {
      logger.warn({ approvalInstanceId }, '[arcNeg] handleArcNegotiationApproval: missing round_id or arc_id in metadata');
      return;
    }

    await db.tx(async (t) => {
      await arcNegotiationModel.updateRoundStatus(roundId, 'ACTIVE', {
        approved_at:  new Date(),
        published_at: new Date(),
      }, t);
      await arcNegotiationModel.updateAllVendorsStatus(roundId, 'APPROVED', t);
      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_STARTED,
        actorId: actorUserId,
        payload:  { round_id: roundId },
        txContext: t,
      });
    });

    // Notify targeted vendors post-commit
    const vendorUsers = await arcNegotiationModel.getVendorsForRound(roundId);
    await notifyArcEvent({
      arcId,
      eventType:         ARC_EVENT_TYPES.NEGOTIATION_ROUND_STARTED,
      actorId:           actorUserId,
      recipientsOverride: vendorUsers,
      payload:            { round_id: roundId },
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[arcNeg] handleArcNegotiationApproval failed');
  }
}

/**
 * Called by approvalActionService when an ARC_NEGOTIATION instance reaches REJECTED.
 * Sets round status = CANCELLED + notifies initiator.
 * Must never throw.
 */
export async function handleArcNegotiationRejection(approvalInstanceId, actorUserId, { comment, instance } = {}) {
  try {
    const roundId = instance?.metadata?.round_id;
    const arcId   = instance?.metadata?.arc_id;
    if (!roundId || !arcId) {
      logger.warn({ approvalInstanceId }, '[arcNeg] handleArcNegotiationRejection: missing round_id or arc_id in metadata');
      return;
    }

    await db.tx(async (t) => {
      await arcNegotiationModel.updateRoundStatus(roundId, 'CANCELLED', {
        closed_at: new Date(),
      }, t);
      await arcNegotiationModel.updateAllVendorsStatus(roundId, 'REJECTED', t);
      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_REJECTED,
        actorId: actorUserId,
        payload:  { round_id: roundId, comment },
        txContext: t,
      });
    });

    removeArcNegotiationRoundExpiration(roundId);

    await notifyArcEvent({
      arcId,
      eventType: ARC_EVENT_TYPES.NEGOTIATION_ROUND_REJECTED,
      actorId:   actorUserId,
      payload:   { round_id: roundId, comment },
    });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[arcNeg] handleArcNegotiationRejection failed');
  }
}
