import db from '../../config/dbConn.js';
import arcModel from '../../models/arc_v2/arcModel.js';
import arcEvalModel from '../../models/arc_v2/arcEvaluationModel.js';
import arcContractClarificationModel from '../../models/arc_v2/arcContractClarificationModel.js';
import arcLifecycleModel from '../../models/arc_v2/arcLifecycleModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';
import { notifyArcEvent } from '../../services/arcNotificationService.js';
import { logger } from '../../util/logger.js';
import {
  createApprovalInstance,
  getApprovalInstanceDetails,
  findBestMatchingPolicyTx,
} from '../../models/generalModel.js';
import { executeApprovalAction, dispatchPostApprovalAction } from '../../services/approvalActionService.js';
import axios from 'axios';

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

// ── Blind technical evaluation (anti-favoritism) ──────────────────────────
// Every TECHNICAL-phase buyer-facing response must emit ONLY the per-ARC alias
// — never the real vendor name/email/company/avatar/initials/vendor_id. The
// alias is resolved server-side from tbl_arc_vendor_alias via
// arcEvalModel.getOrAssignAliases(arcId). The reveal happens only at the
// COMMERCIAL stage (getCommEval and downstream), which is left untouched.
//
// Returns { vendor_alias_key, vendor_alias } for a real vendor_id; falls back
// to a synthetic label keyed on the id WITHOUT ever exposing the id itself, so
// even an un-aliased vendor (should not happen after getOrAssignAliases) cannot
// leak its real identity through the JSON.
function aliasFields(vendorId, aliasMap) {
  const a = aliasMap && aliasMap.get(Number(vendorId));
  if (a) return { vendor_alias_key: a.alias_index, vendor_alias: a.alias_label };
  return { vendor_alias_key: null, vendor_alias: arcEvalModel.aliasLabel(0) };
}

// Shared catch: lifecycle guards throw {httpStatus:409, code:'STAGE_IMMUTABLE'};
// everything else is a 500.
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

// Resolve the ARC_<TYPE> approval policy with fallback to the generic 'ARC'
// policy (same chain as amendments).
async function resolveArcPolicy(entityType, scope, t) {
  let policy = await findBestMatchingPolicyTx({ entity_type: entityType, ...scope }, t);
  if (!policy) policy = await findBestMatchingPolicyTx({ entity_type: 'ARC', ...scope }, t);
  return policy;
}

// ============================================================
// TECH EVAL endpoints
// ============================================================

export async function setupTechEval(req, res) {
  try {
    const arcItemId = Number(req.params.itemId);
    const { minimum_passing_score, clauses = [] } = req.body || {};

    // ── Value validation (security-first — never trust the client; the FE
    // gate can be bypassed by resuming a draft and jumping straight to
    // Review/Submit, so this is the authoritative backstop). Sr 13/44/45/46 +
    // the in-scope slice of Sr 15 (per-item clause weights must sum to 100 —
    // the ARC tech-eval model IS per-item, see arcEvaluationModel.computeItemScores;
    // a single ARC-wide clause set is a separate, deferred scoring-model change).
    const mps = Number(minimum_passing_score);
    if (
      minimum_passing_score === undefined || minimum_passing_score === null || minimum_passing_score === ''
      || !Number.isFinite(mps) || !Number.isInteger(mps)
    ) {
      return bad(res, 400, 'A valid minimum passing score (1–100) is required.');
    }
    if (mps < 1)   return bad(res, 400, 'Minimum passing score must be at least 1%.');
    if (mps > 100) return bad(res, 400, 'Minimum passing score cannot exceed 100%.');

    if (!Array.isArray(clauses) || clauses.length === 0) {
      return bad(res, 400, 'At least one clause is required.');
    }
    let weightSum = 0;
    for (let i = 0; i < clauses.length; i++) {
      const c = clauses[i] || {};
      const text = typeof c.clause_text === 'string' ? c.clause_text.trim() : '';
      if (!text) return bad(res, 400, `Clause ${i + 1} requires non-empty clause text.`);
      const w = Number(c.weightage);
      if (!Number.isFinite(w) || !Number.isInteger(w) || w < 1 || w > 100) {
        return bad(res, 400, `Clause ${i + 1} weightage must be a whole number between 1 and 100.`);
      }
      weightSum += w;
    }
    if (weightSum !== 100) {
      return bad(res, 400, `Clause weightage must total exactly 100 (got ${weightSum}).`);
    }

    // Immutable once technical is approved; also blocked once commercial is
    // finalized (configuring clauses then would un-skip technical under a
    // locked award).
    const arcId = await arcLifecycleModel.getArcIdForItem(arcItemId);
    if (!arcId) return bad(res, 404, 'ARC item not found', 2);
    await arcLifecycleModel.assertStageWritable(arcId, 'technical');
    await arcLifecycleModel.assertStageWritable(arcId, 'commercial');
    // Respond only AFTER the tx commits — sending inside the callback races
    // the caller's next request against an uncommitted transaction.
    const result = await db.tx(async (t) => {
      const te = await arcEvalModel.upsertTechEval(arcItemId, { minimum_passing_score }, t);
      // Replace-semantics (GROUP D): clear any previously configured clauses
      // before inserting the submitted set, so a second call for the same item
      // (Save-draft → resume → edit clauses → Save-draft again) REPLACES rather
      // than accumulates duplicate clause rows. A no-op the first time (nothing
      // to clear yet), so today's single-call flow is unaffected.
      await arcEvalModel.clearClauses(te.id, t);
      const inserted = [];
      for (const c of clauses) {
        inserted.push(await arcEvalModel.addClause(te.id, c, t));
      }
      return { tech_evaluation: te, clauses: inserted };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err, '[evalController.setupTechEval]');
  }
}

// NOTE: the buyer-records-vendor-response endpoint (recordVendorResponse /
// POST /tech-eval/response) was REMOVED — RESOLVED DECISION 2. Vendors now
// self-author their technical responses + evidence via the vendor portal
// (two-envelope flow); the buyer ONLY scores vendor-submitted responses below.

export async function scoreResponse(req, res) {
  try {
    const userId = req.user?.id;
    const { response_id, buyer_marks, buyer_remark, mandatory_passed } = req.body || {};
    if (!response_id || buyer_marks == null) return bad(res, 400, 'response_id and buyer_marks are required');
    const arcId = await arcLifecycleModel.getArcIdForResponse(response_id);
    if (!arcId) return bad(res, 404, 'Response not found', 2);
    await arcLifecycleModel.assertStageWritable(arcId, 'technical');
    // Is the clause behind this response mandatory? Mandatory clauses REQUIRE a
    // pass/fail verdict; non-mandatory clauses force the verdict to NULL so a
    // stray client-supplied value never gates a non-gated clause.
    const clause = await db.oneOrNone(
      `SELECT c.is_mandatory
         FROM tbl_arc_item_tech_evaluation_vendors_response r
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
        WHERE r.id = $1`,
      [response_id]
    );
    let verdict; // undefined → leave untouched
    if (clause?.is_mandatory) {
      if (typeof mandatory_passed !== 'boolean') {
        return bad(res, 400, 'mandatory_passed (true/false) is required for a mandatory clause');
      }
      verdict = mandatory_passed;
    } else {
      verdict = null; // ignore/clear any value on a non-mandatory clause
    }
    const row = await arcEvalModel.scoreVendorResponse(response_id, {
      buyer_id: userId, buyer_marks, buyer_remark, mandatory_passed: verdict,
    });
    // BLIND EVAL: the model row carries the real vendor_id — strip it and emit
    // the stable per-ARC alias instead. The FE keys the echo on response_id +
    // alias_key, so no real identity is needed (or sent).
    const aliasMap = await arcEvalModel.getOrAssignAliases(arcId);
    const { vendor_id, ...rest } = row;
    return ok(res, { response: { ...rest, ...aliasFields(vendor_id, aliasMap) } });
  } catch (err) {
    return fail(res, err, '[evalController.scoreResponse]');
  }
}

export async function getTechEvalForItem(req, res) {
  try {
    const arcItemId = Number(req.params.itemId);
    const te = await db.oneOrNone(`SELECT * FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`, [arcItemId]);
    if (!te) return ok(res, { tech_evaluation: null, clauses: [], scores: [], responses: [] });
    // BLIND EVAL: resolve the ARC and its stable per-vendor aliases. Every
    // vendor in play here gets an alias (this read is alias-assigning + safe to
    // call repeatedly), so identity is replaced before anything leaves the box.
    const arcId = await arcLifecycleModel.getArcIdForItem(arcItemId);
    const aliasMap = arcId ? await arcEvalModel.getOrAssignAliases(arcId) : new Map();
    // Which vendors have actually submitted a COMMERCIAL quote (not just a
    // technical envelope)? The buyer can hide tech-only vendors who will never
    // reach the commercial stage, so the technical evaluator's time isn't spent
    // scoring vendors who won't be considered. Per-vendor flag, alias-safe.
    const quotedRows = arcId ? await db.any(
      `SELECT vendor_id FROM tbl_arc_quote
        WHERE arc_id = $1 AND submitted_at IS NOT NULL AND withdrawn_at IS NULL`,
      [arcId]
    ) : [];
    const quotedSet = new Set(quotedRows.map((r) => Number(r.vendor_id)));

    // Sr 54 — commercial-ranked shortlist gate (blind-preserving, OQ1=A):
    // only the top-5 (by whole-ARC commercial rank) vendors are technically
    // evaluated; the rest are held. Lazy backstop — computes it here if the
    // submission-close hook hasn't run yet (manual-entry ARCs, lazy-flip
    // path). `gateActive` stays false (fail-open, unfiltered) only in the
    // edge case where literally nobody has a rankable commercial quote yet.
    const shortlistRows = arcId ? await arcEvalModel.ensureShortlist(arcId) : [];
    const inEvalIds = arcEvalModel.shortlistVendorIds(shortlistRows);
    const gateActive = shortlistRows.length > 0;
    const shortlistCounts = arcEvalModel.shortlistCounts(shortlistRows);

    // listClauses does SELECT * so is_mandatory comes along once the column
    // exists — no change needed there.
    const clauses = await arcEvalModel.listClauses(te.id);
    // computeItemScores returns real vendor_id (server-internal) — remap to the
    // alias and DROP vendor_id before it reaches the browser. Gated to the
    // in-eval shortlist: on-hold vendors are never surfaced to the evaluator.
    const rawScores = await arcEvalModel.computeItemScores(arcItemId);
    const scores = rawScores
      .filter((s) => !gateActive || inEvalIds.has(Number(s.vendor_id)))
      .map((s) => {
        const { vendor_id, ...rest } = s;
        return { ...aliasFields(vendor_id, aliasMap), ...rest, has_submitted_quote: quotedSet.has(Number(vendor_id)) };
      });
    // Per-(clause × vendor) response rows — the scoring matrix binds inputs
    // to response_id, so the cells need these (scores alone are per-vendor
    // aggregates). vendor_response is now VENDOR-authored (two-envelope flow);
    // the buyer scores it read-only. mandatory_passed carries the gate verdict.
    //
    // BLIND EVAL: NO LEFT JOIN tbl_users / no vendor_name; vendor_id is selected
    // internally ONLY for alias mapping + grouping and is NEVER emitted. files
    // drop file_url (the S3 key could embed a vendor-identifying path) — only
    // file_id (the evidence-proxy handle) survives. ORDER BY is keyed off the
    // stable alias rows (via the alias join) and response_id, NOT r.vendor_id,
    // so the matrix column order does not leak vendor_id order.
    const rawResponses = await db.any(
      `SELECT r.id AS response_id,
              r.arc_item_tech_evaluation_clauses_id AS clause_id,
              r.vendor_id,
              r.vendor_response, r.buyer_marks, r.buyer_remark,
              r.mandatory_passed, r.score_timestamp,
              COALESCE(f.files, '[]'::json) AS files
         FROM tbl_arc_item_tech_evaluation_vendors_response r
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
         LEFT JOIN tbl_arc_vendor_alias a ON a.arc_id = $2 AND a.vendor_id = r.vendor_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('file_id', vf.id) ORDER BY vf.id) AS files
             FROM tbl_arc_item_tech_evaluation_vendors_response_files vf
            WHERE vf.arc_item_tech_evaluation_vendors_response_id = r.id
         ) f ON TRUE
        WHERE c.arc_item_tech_evaluation_id = $1
        ORDER BY a.alias_index NULLS LAST, r.id`,
      [te.id, arcId]
    );
    const responses = rawResponses
      .filter((row) => !gateActive || inEvalIds.has(Number(row.vendor_id)))
      .map((row) => {
        const { vendor_id, ...rest } = row;
        return { ...rest, ...aliasFields(vendor_id, aliasMap), has_submitted_quote: quotedSet.has(Number(vendor_id)) };
      });
    // Sr 54 — membership + counts ONLY (blind-preserving): the evaluator never
    // sees prices, basket totals, rank numbers, or on-hold vendor identities.
    return ok(res, { tech_evaluation: te, clauses, scores, responses, shortlist: shortlistCounts });
  } catch (err) {
    logger.error({ err }, '[evalController.getTechEvalForItem]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

// ============================================================
// GET /v1/arc-v2/evaluation/tech-eval/evidence/:fileId
//   Evaluator-side evidence proxy. The requireArcPermission(TECH_READ) gate
//   already verified the caller holds the ARC's tech-read permission (scoped
//   to the file's ARC, resolved in the middleware). We stream the bytes
//   server-side so the raw S3 URL never reaches the browser.
// ============================================================
export async function getTechEvidenceFile(req, res) {
  try {
    const fileId = Number(req.params.fileId);
    if (!fileId) return bad(res, 400, 'fileId is required');
    const file = await arcEvalModel.getResponseFileWithScope(fileId);
    if (!file) return bad(res, 404, 'Evidence file not found', 2);
    // Ownership/permission already enforced by requireArcPermission on the ARC
    // that owns this file. Fetch the bytes server-side and stream them back.
    const resp = await axios.get(file.file_url, {
      responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024,
    });
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="evidence-${fileId}"`);
    return res.status(200).send(Buffer.from(resp.data));
  } catch (err) {
    logger.error({ err }, '[evalController.getTechEvidenceFile]');
    return bad(res, 500, err.message || 'Internal error', 3);
  }
}

export async function submitTechEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    const arc = await arcModel.getById(arcId);
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    await arcLifecycleModel.assertStageWritable(arcId, 'technical');

    // One in-flight approval round at a time.
    const pending = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type = 'ARC_TECH' AND entity_id = $1 AND status = 'PENDING'
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (pending) {
      return bad(res, 400, `Technical evaluation is already with the approvers (instance #${pending.id}).`);
    }

    const result = await db.tx(async (t) => {
      const items = await arcModel.listItems(arcId, t);
      // Sr 54 — gate qualification recording to the in-eval shortlist. Lazy
      // backstop: ensures the shortlist exists even if the submission-close
      // hook hasn't run yet. `gateActive` fails open (no filtering) only when
      // literally nobody has a rankable commercial quote yet.
      const shortlistRows = await arcEvalModel.ensureShortlist(arcId, {}, t);
      const inEvalIds = arcEvalModel.shortlistVendorIds(shortlistRows);
      const gateActive = shortlistRows.length > 0;

      const techEvalIds = [];
      for (const item of items) {
        const scores = await arcEvalModel.computeItemScores(item.id, 1, t);
        const gatedScores = gateActive ? scores.filter((s) => inEvalIds.has(Number(s.vendor_id))) : scores;
        const te = await t.oneOrNone(
          `SELECT id FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`, [item.id]
        );
        if (te) techEvalIds.push(te.id);
        if (te && gatedScores.length > 0) {
          await arcEvalModel.recordClearedVendors(
            te.id,
            gatedScores.map(s => ({ ...s, created_by: userId, evaluation_round: 1 })),
            t
          );
        }
      }

      // Sr 54 (OQ4=Automatic) — a shortlisted vendor who just ended up
      // not_qualified auto-promotes the next held vendor (by commercial rank)
      // into evaluation. Idempotent; logged for audit (buyer-internal, never
      // surfaced to the tech-eval payload).
      const promotions = await arcEvalModel.reconcileShortlistPromotions(arcId, { userId }, t);
      for (const p of promotions) {
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.TECH_SHORTLIST_PROMOTED, actorId: userId,
          payload: { vendor_id: p.vendor_id, commercial_rank: p.commercial_rank }, txContext: t,
        });
      }

      // Route through the central engine (entity_type ARC_TECH, fallback
      // to the generic ARC policy — same chain as amendments). The
      // registered hooks flip the ARC to tech_eval_approved / _rejected.
      const policy = await resolveArcPolicy('ARC_TECH', {
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
      }, t);
      if (!policy) {
        const err = new Error('No approval policy configured for ARC technical evaluation in this scope.');
        err.httpStatus = 400;
        throw err;
      }
      const engineResult = await createApprovalInstance({
        entity_type:            'ARC_TECH',
        entity_id:              arcId,
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata:               { item_count: items.length },
        txContext:              t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');
      if (techEvalIds.length > 0) {
        await t.none(
          `UPDATE tbl_arc_item_tech_evaluation SET approval_instance_id = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id IN ($2:csv)`,
          [instanceRow.id, techEvalIds]
        );
      }

      await arcModel.setStatus(arcId, 'tech_eval_in_progress', {}, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_SUBMITTED, actorId: userId,
        payload: { approval_instance_id: instanceRow.id }, txContext: t,
      });
      return { ok: true, approval_instance_id: instanceRow.id, auto_approved: engineResult.autoApproved === true, promotions };
    });
    // The engine auto-approves when the submitter is also the (only/ANY)
    // approver — the instance is born APPROVED and executeApprovalAction
    // never runs, so the post-approval side effects must be fired here.
    if (result.auto_approved) {
      await dispatchPostApprovalAction(result.approval_instance_id, userId, {
        status: 'APPROVED', comment: 'Auto-approved — submitter is the configured approver',
      });
    }
    // Notify creator (in-app) post-commit
    await notifyArcEvent({ arcId: Number(req.params.arcId), eventType: ARC_EVENT_TYPES.TECH_EVAL_SUBMITTED, actorId: userId, payload: {} });
    // Sr 54 — notify tech evaluators of any auto-promotion(s), post-commit.
    // Blind-preserving (OQ1): the evaluator learns THAT a vendor was promoted, never
    // its commercial_rank / basket_total.
    for (const p of result.promotions || []) {
      await notifyArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.TECH_SHORTLIST_PROMOTED, actorId: userId,
        payload: { vendor_id: p.vendor_id },
      });
    }
    // Redact the shortlist rows before responding — the evaluator response may report
    // THAT N vendors were promoted, but never their rank/basket/order. The promoted
    // vendor's ALIAS surfaces via the next getTechEvalForItem, not here.
    result.promotions = (result.promotions || []).map((p) => ({ status: p.status }));
    // respond after commit — never inside the tx
    return ok(res, result);
  } catch (err) {
    return fail(res, err, '[evalController.submitTechEval]');
  }
}

// ============================================================
// GET /v1/arc-v2/evaluation/:arcId/tech-eval/approval
//   Full ARC_TECH chain (steps, approvers, comments) + per-caller
//   can_user_approve — powers the Technical stage's approval matrix.
// ============================================================
export async function getTechEvalApproval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_TECH' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (!instance) return ok(res, { approval: null });
    const approval = await getApprovalInstanceDetails(instance.id, req.user?.id || null);
    const edits = await db.any(
      `SELECT eh.*, u.name AS changed_by_name
         FROM tbl_arc_tech_eval_edit_history eh
         LEFT JOIN tbl_users u ON u.id = eh.changed_by
        WHERE eh.arc_id = $1
        ORDER BY eh.changed_at DESC, eh.id DESC`,
      [arcId]
    );
    return ok(res, { approval, edit_history: edits });
  } catch (err) {
    return fail(res, err, '[evalController.getTechEvalApproval]');
  }
}

// ============================================================
// POST /v1/arc-v2/evaluation/:arcId/tech-eval/decide
//   Body: { decision:'approve'|'reject', comment?, amend?:{marks:[...]} }
//   The approver may AMEND any vendor's marks before approving — each
//   change lands in tbl_arc_tech_eval_edit_history and is folded into the
//   engine comment (mirrors the amendments edit-then-approve pattern).
//   executeApprovalAction validates the caller is the current approver and
//   fires the ARC_TECH hooks on terminal states.
// ============================================================
export async function decideTechEval(req, res) {
  try {
    const arcId    = Number(req.params.arcId);
    const userId   = req.user?.id;
    const decision = String(req.body?.decision || '').trim();
    const comment  = req.body?.comment ? String(req.body.comment) : null;
    const amendMarks = Array.isArray(req.body?.amend?.marks) ? req.body.amend.marks : [];

    if (!userId) return bad(res, 401, 'Authentication required');
    if (decision !== 'approve' && decision !== 'reject') {
      return bad(res, 400, "decision must be 'approve' or 'reject'");
    }
    if (decision === 'reject' && !comment) {
      return bad(res, 400, 'A reason (comment) is required when rejecting');
    }

    const instance = await db.oneOrNone(
      `SELECT * FROM tbl_approval_instances
        WHERE entity_type = 'ARC_TECH' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [arcId]
    );
    if (!instance) return bad(res, 404, 'No technical-evaluation approval instance for this ARC', 2);
    if (instance.status !== 'PENDING') {
      return bad(res, 400, `Technical evaluation is already ${instance.status} — no further actions allowed`);
    }

    // ── amend-then-approve: apply edited marks + record diffs ──
    let engineComment = comment;
    const amended = [];
    const touchedItemIds = new Set();
    let shortlistPromotions = [];
    if (decision === 'approve' && amendMarks.length > 0) {
      await db.tx(async (t) => {
        for (const m of amendMarks) {
          const responseId = Number(m.response_id);
          if (!responseId) continue;
          const current = await t.oneOrNone(
            `SELECT r.*, i.id AS arc_item_id, c.is_mandatory
               FROM tbl_arc_item_tech_evaluation_vendors_response r
               JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
               JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
               JOIN tbl_arc_item i ON i.id = te.arc_item_id
              WHERE r.id = $1 AND i.arc_id = $2`,
            [responseId, arcId]
          );
          if (!current) continue;

          const diffs = [];
          if (m.buyer_marks != null && Number(m.buyer_marks) !== Number(current.buyer_marks)) {
            diffs.push({ field: 'buyer_marks', before: current.buyer_marks, after: Number(m.buyer_marks) });
          }
          if (m.buyer_remark !== undefined && String(m.buyer_remark ?? '') !== String(current.buyer_remark ?? '')) {
            diffs.push({ field: 'buyer_remark', before: current.buyer_remark, after: m.buyer_remark ?? null });
          }
          // Mandatory verdict amend — only meaningful on a mandatory clause.
          // A boolean flip (incl. judging a previously-NULL verdict) is recorded.
          if (current.is_mandatory && m.mandatory_passed !== undefined
              && (m.mandatory_passed === null ? null : !!m.mandatory_passed) !== current.mandatory_passed) {
            diffs.push({
              field: 'mandatory_passed',
              before: current.mandatory_passed,
              after: m.mandatory_passed === null ? null : !!m.mandatory_passed,
            });
          }
          if (diffs.length === 0) continue;

          for (const d of diffs) {
            await t.none(
              `INSERT INTO tbl_arc_tech_eval_edit_history
                 (arc_id, response_id, field_changed, before_value, after_value, changed_by, comment)
               VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
              [arcId, responseId, d.field,
               JSON.stringify(d.before ?? null), JSON.stringify(d.after ?? null),
               userId, comment]
            );
            amended.push({ response_id: responseId, field_changed: d.field, before_value: d.before ?? null, after_value: d.after ?? null });
          }
          await arcEvalModel.scoreVendorResponse(responseId, {
            buyer_id: userId,
            buyer_marks: m.buyer_marks != null ? Number(m.buyer_marks) : current.buyer_marks,
            buyer_remark: m.buyer_remark !== undefined ? m.buyer_remark : current.buyer_remark,
            // Only carry a verdict on mandatory clauses; non-mandatory stays NULL.
            ...(current.is_mandatory && m.mandatory_passed !== undefined
              ? { mandatory_passed: m.mandatory_passed === null ? null : !!m.mandatory_passed }
              : {}),
          }, t);
          touchedItemIds.add(Number(current.arc_item_id));
        }

        // Sr 54 — gate qualification recording to the in-eval shortlist, same
        // as submitTechEval (an on-hold vendor's response can never be
        // recorded into cleared_vendors even via a direct amend call).
        const shortlistRows = await arcEvalModel.ensureShortlist(arcId, {}, t);
        const inEvalIds = arcEvalModel.shortlistVendorIds(shortlistRows);
        const gateActive = shortlistRows.length > 0;

        // Recompute qualification for every touched item so the approved
        // record reflects the amended marks.
        for (const itemId of touchedItemIds) {
          const scores = await arcEvalModel.computeItemScores(itemId, 1, t);
          const gatedScores = gateActive ? scores.filter((s) => inEvalIds.has(Number(s.vendor_id))) : scores;
          const te = await t.oneOrNone(
            `SELECT id FROM tbl_arc_item_tech_evaluation WHERE arc_item_id = $1`, [itemId]
          );
          if (te && gatedScores.length > 0) {
            await arcEvalModel.recordClearedVendors(
              te.id,
              gatedScores.map(s => ({ ...s, created_by: userId, evaluation_round: 1 })),
              t
            );
          }
        }

        // Sr 54 (OQ4=Automatic) — an amended verdict can flip a shortlisted
        // vendor to not_qualified; auto-promote the next held vendor.
        shortlistPromotions = await arcEvalModel.reconcileShortlistPromotions(arcId, { userId }, t);
        for (const p of shortlistPromotions) {
          await logArcEvent({
            arcId, eventType: ARC_EVENT_TYPES.TECH_SHORTLIST_PROMOTED, actorId: userId,
            payload: { vendor_id: p.vendor_id, commercial_rank: p.commercial_rank }, txContext: t,
          });
        }
      });
      if (amended.length > 0) {
        const summary = amended
          .map((d) => `response ${d.response_id} ${d.field_changed}: ${JSON.stringify(d.before_value)} → ${JSON.stringify(d.after_value)}`)
          .join('; ');
        engineComment = `[Edited before approval] ${summary}${comment ? ` — ${comment}` : ''}`;
      }
    }

    const result = await executeApprovalAction({
      approval_instance_id: instance.id,
      approver_user_id:     userId,
      action:               decision.toUpperCase(),
      comment:              engineComment,
    });

    // Sr 54 — notify tech evaluators of any auto-promotion(s) triggered by
    // this amend, post-commit (the amend tx already committed above).
    // Blind-preserving (OQ1): evaluator learns THAT a vendor was promoted, never its rank.
    for (const p of shortlistPromotions) {
      await notifyArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.TECH_SHORTLIST_PROMOTED, actorId: userId,
        payload: { vendor_id: p.vendor_id },
      });
    }

    const approval = await getApprovalInstanceDetails(instance.id, userId).catch(() => null);
    // BLIND EVAL: the approver stays blind too. Fresh per-item scores for the
    // touched items (UI refresh without refetch-all), with the real vendor_id
    // remapped to the stable per-ARC alias and dropped. `amended[]` is already
    // response_id-scoped (no identity); `approval` is the buyer approver chain.
    const aliasMap = await arcEvalModel.getOrAssignAliases(arcId);
    // Sr 54 — same shortlist gate as getTechEvalForItem: an on-hold vendor's
    // score never reaches the approver either.
    const shortlistRowsOut = await arcEvalModel.getShortlist(arcId);
    const inEvalIdsOut = arcEvalModel.shortlistVendorIds(shortlistRowsOut);
    const gateActiveOut = shortlistRowsOut.length > 0;
    const scores = [];
    for (const itemId of touchedItemIds) {
      const itemScores = await arcEvalModel.computeItemScores(itemId, 1);
      for (const s of itemScores) {
        if (gateActiveOut && !inEvalIdsOut.has(Number(s.vendor_id))) continue;
        const { vendor_id, ...rest } = s;
        scores.push({ arc_item_id: itemId, ...aliasFields(vendor_id, aliasMap), ...rest });
      }
    }
    return ok(res, { result, approval, amended, scores });
  } catch (err) {
    logger.error({ err }, '[evalController.decideTechEval]');
    const msg = err.message || 'Internal error';
    const code = /not authorized|not an approver|already acted|already (approved|rejected)|not found|no pending step/i.test(msg) ? 400 : 500;
    return bad(res, code, msg, code === 500 ? 3 : 0);
  }
}

// ============================================================
// COMMERCIAL EVAL endpoints
// ============================================================

export async function getCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    // The page needs the ARC context too — previously this endpoint returned
    // no `arc` key and the comm-eval page rendered "Rate contract not found".
    const arc = await db.oneOrNone(
      `SELECT a.*, cat.title AS category_title, h.name AS hotel_name,
              d.title AS department_title, u.name AS created_by_name
         FROM tbl_arc a
         LEFT JOIN tbl_category cat ON cat.id = a.category_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN tbl_department d ON d.id = a.department_id
         LEFT JOIN tbl_users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [arcId]
    );
    if (!arc) return bad(res, 404, 'ARC not found', 2);
    const items = await arcModel.listItems(arcId);
    const quotes = await arcEvalModel.listAllQuotesForArc(arcId);
    const comm = await arcEvalModel.getCommEval(arcId);
    const awards = comm ? await arcEvalModel.listAwards(comm.id) : [];
    // item_id → qualified vendor ids (only items WITH technical clauses).
    const qualified_by_item = await arcEvalModel.qualifiedVendorsByItem(arcId);
    // REDACTION: the technical committee deemed these vendor × item pairs
    // unfit — their commercial terms must never reach the commercial
    // evaluator's browser. Strip pricing server-side, keep the line as a
    // marker so the matrix can show a locked cell.
    const redacted = quotes.map((q) => {
      const allowed = qualified_by_item[Number(q.arc_item_id)];
      if (allowed && !allowed.includes(Number(q.vendor_id))) {
        return {
          quote_id: q.quote_id, vendor_id: q.vendor_id, vendor_name: q.vendor_name,
          submitted_at: q.submitted_at, quote_line_id: q.quote_line_id, arc_item_id: q.arc_item_id,
          rate: null, gst_pct: null, charges: null, lead_time_days: null, moq: null,
          // Phase 2 — null out engine output for technically-disqualified vendors
          // so the commercial evaluator never sees their pricing.
          line_pricing: null,
          technically_disqualified: true,
        };
      }
      return q;
    });
    // All clarifications on the ARC (open + resolved). Open ones drive the
    // "needs your decision" panel; resolved 'revised' ones let the matrix
    // overlay the new value on the awarded cell with who/why provenance.
    const clarifications = await arcContractClarificationModel
      .listForArc(arcId)
      .catch((err) => {
        if (/relation .* does not exist/i.test(err.message)) return [];
        throw err;
      });
    return ok(res, { arc, comm_evaluation: comm, items, quotes: redacted, awards, qualified_by_item, clarifications });
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
    // Locked = technical not yet approved/skipped — awarding against
    // unratified qualification is rejected outright.
    const lifecycle = await arcLifecycleModel.assertStageWritable(arcId, 'commercial', null, { blockLocked: true });
    const result = await db.tx(async (t) => {
      const item = await t.oneOrNone(`SELECT * FROM tbl_arc_item WHERE id = $1 AND arc_id = $2`, [item_id, arcId]);
      if (!item) return bad(res, 404, 'item not found', 2);
      // Empty allocations[] = explicit CLEAR — the item returns to pending.
      // Non-empty allocations must reconcile to the indicative qty and only
      // name vendors the (approved) technical evaluation qualified.
      if (allocations.length > 0) {
        const sum = allocations.reduce((s, a) => s + Number(a.allocated_qty || 0), 0);
        const target = Number(item.indicative_qty);
        if (Math.abs(sum - target) > 1e-6) {
          return bad(res, 400, `Allocations sum (${sum}) must equal indicative_qty (${target})`);
        }
        const qualifiedMap = await arcEvalModel.qualifiedVendorsByItem(arcId, t);
        const allowed = qualifiedMap[Number(item_id)];
        if (allowed) {
          const notQualified = allocations.find((a) => !allowed.includes(Number(a.awarded_vendor_id)));
          if (notQualified) {
            return bad(res, 400, `Vendor ${notQualified.awarded_vendor_id} is not technically qualified for this item`);
          }
        }
      }
      const comm = await arcEvalModel.upsertCommEval(arcId, t);
      // First commercial action advances the ARC's raw status — the hero
      // chip and list deep-links read it, so it must not linger on
      // tech_eval_approved (or submission_closed when technical was skipped).
      let commEvalJustOpened = false;
      if (['tech_eval_approved', 'submission_closed'].includes(lifecycle.arc.status)) {
        await arcModel.setStatus(arcId, 'comm_eval_in_progress', {}, t);
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_OPENED,
          actorId: userId, payload: {}, txContext: t,
        });
        commEvalJustOpened = true;
      }
      const inserted = await arcEvalModel.setItemAwards(comm.id, item_id, allocations, t);
      await arcEvalModel.appendCommEvalHistory(
        comm.id, allocations.length ? 'allocation_saved' : 'allocation_cleared',
        { item_id, allocations }, userId, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_ALLOCATION_UPDATED,
        actorId: userId, payload: { item_id, vendor_count: allocations.length }, txContext: t,
      });
      return { __data: { comm_evaluation: comm, awards: inserted }, __commEvalOpened: commEvalJustOpened };
    });
    // respond after commit — a response sent inside the tx races the
    // caller's next request against uncommitted state
    if (result && result.__data) {
      if (result.__commEvalOpened) {
        await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_OPENED, actorId: userId, payload: {} });
      }
      return ok(res, result.__data);
    }
    return result;
  } catch (err) {
    return fail(res, err, '[evalController.saveAllocation]');
  }
}

export async function finalizeCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    // Can't finalize a stage that never opened (technical unapproved).
    await arcLifecycleModel.assertStageWritable(arcId, 'commercial', null, { blockLocked: true });
    const result = await db.tx(async (t) => {
      const arc = await arcModel.getById(arcId, t);
      if (!arc) return bad(res, 404, 'ARC not found', 2);
      const items = await arcModel.listItems(arcId, t);
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (!comm) return bad(res, 400, 'Commercial evaluation has not been started');
      if (comm.status === 'finalized') {
        return res.status(409).json({
          status: 0, code: 'STAGE_IMMUTABLE',
          message: 'Commercial evaluation is already finalized',
        });
      }
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
      // Defense against stale awards saved before a technical re-evaluation:
      // every awarded vendor must still be qualified for their item.
      const qualifiedMap = await arcEvalModel.qualifiedVendorsByItem(arcId, t);
      const staleAward = awards.find((a) => {
        const allowed = qualifiedMap[Number(a.arc_item_id)];
        return allowed && !allowed.includes(Number(a.awarded_vendor_id));
      });
      if (staleAward) {
        return bad(res, 400,
          `Vendor ${staleAward.awarded_vendor_id} is no longer technically qualified for item ${staleAward.arc_item_id} — re-allocate before finalizing`);
      }

      // Spawn the committee approval through the central engine — the
      // Awarding stage becomes actionable the moment commercial finalizes.
      const policy = await resolveArcPolicy('ARC_COMMITTEE', {
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
      }, t);
      if (!policy) {
        const err = new Error('No approval policy configured for the ARC committee in this scope.');
        err.httpStatus = 400;
        throw err;
      }
      const engineResult = await createApprovalInstance({
        entity_type:            'ARC_COMMITTEE',
        entity_id:              arcId,
        hospitality_company_id: arc.hospitality_company_id,
        hotel_id:               arc.hotel_id,
        department_id:          arc.department_id,
        process_id:             arc.process_id,
        approval_policy_id:     policy.id,
        initiated_by:           userId,
        metadata:               { item_count: items.length, award_count: awards.length },
        txContext:              t,
      });
      const instanceRow = engineResult?.instance || engineResult;
      if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');

      const updated = await arcEvalModel.setCommEvalStatus(comm.id, 'finalized', {
        finalized_by: userId,
        finalized_at: new Date(),
        approval_instance_id: instanceRow.id,
      }, t);
      await arcModel.setStatus(arcId, 'committee_review', {}, t);
      await arcEvalModel.appendCommEvalHistory(comm.id, 'finalized', { item_count: items.length }, userId, t);
      await logArcEvent({
        arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_FINALIZED,
        actorId: userId, payload: { item_count: items.length, approval_instance_id: instanceRow.id }, txContext: t,
      });
      return {
        __data: { comm_evaluation: updated, approval_instance_id: instanceRow.id },
        __autoApproved: engineResult.autoApproved === true,
      };
    });
    if (result && result.__data) {
      // Auto-approved at creation (finalizer is also the committee approver):
      // executeApprovalAction never runs, so fire the post-approval effects
      // (contract generation, status flips) here — AFTER the commit.
      if (result.__autoApproved) {
        await dispatchPostApprovalAction(result.__data.approval_instance_id, userId, {
          status: 'APPROVED', comment: 'Auto-approved — finalizer is the configured committee approver',
        });
      }
      // Notify creator (BOTH email) post-commit
      await notifyArcEvent({ arcId: Number(req.params.arcId), eventType: ARC_EVENT_TYPES.COMM_EVAL_FINALIZED, actorId: userId, payload: {} });
      return ok(res, result.__data, 'Commercial evaluation finalized');
    }
    return result;
  } catch (err) {
    return fail(res, err, '[evalController.finalizeCommEval]');
  }
}

export async function sendBackCommEval(req, res) {
  try {
    const arcId = Number(req.params.arcId);
    const userId = req.user?.id;
    const reason = req.body?.reason;
    const result = await db.tx(async (t) => {
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (!comm) return bad(res, 404, 'comm eval not found', 2);

      // Once the committee has approved, contracts exist — irreversible here.
      const committee = await t.oneOrNone(
        `SELECT id, status FROM tbl_approval_instances
          WHERE entity_type = 'ARC_COMMITTEE' AND entity_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [arcId]
      );
      if (committee?.status === 'APPROVED') {
        return res.status(409).json({
          status: 0, code: 'STAGE_IMMUTABLE',
          message: 'The committee has already approved — contracts are generated and the award is immutable',
        });
      }
      // A PENDING committee vote becomes moot when the evaluator pulls the
      // proposal back — cancel it so a later re-finalize can spawn a fresh one.
      if (committee?.status === 'PENDING') {
        await t.none(
          `UPDATE tbl_approval_instances
              SET status = 'CANCELLED', completed_at = NOW()
            WHERE id = $1`,
          [committee.id]
        );
      }

      const updated = await arcEvalModel.setCommEvalStatus(comm.id, 'sent_back', {}, t);
      await arcModel.setStatus(arcId, 'comm_eval_in_progress', {}, t);
      await arcEvalModel.appendCommEvalHistory(comm.id, 'sent_back', { reason, cancelled_instance_id: committee?.status === 'PENDING' ? committee.id : null }, userId, t);
      await logArcEvent({ arcId, eventType: ARC_EVENT_TYPES.COMM_EVAL_SENT_BACK, actorId: userId, payload: { reason }, txContext: t });
      return { __data: { comm_evaluation: updated } };
    });
    // respond after commit — never inside the tx
    if (result && result.__data) {
      await notifyArcEvent({ arcId: Number(req.params.arcId), eventType: ARC_EVENT_TYPES.COMM_EVAL_SENT_BACK, actorId: userId, payload: { reason: req.body?.reason } });
      return ok(res, result.__data, 'Sent back');
    }
    return result;
  } catch (err) {
    return fail(res, err, '[evalController.sendBackCommEval]');
  }
}

// ============================================================
// Vendor-clarification resolution (commercial evaluator).
//   POST /v1/arc-v2/evaluation/:arcId/comm-eval/clarification/:clarificationId/revise
//     Body: { value, response? }  — overrides ONLY the disputed field on the
//     award snapshot (price/term) or shifts committed_qty (+ indicative_qty).
//   POST .../clarification/:clarificationId/uphold
//     Body: { response }          — keeps the value, records the reply.
//
// SURGICAL — the commercial stage stays FINALIZED/locked throughout. The
// evaluator can ONLY revise the disputed value or uphold it (no re-allocation,
// no vendor deselection). When the LAST open clarification on the ARC is
// resolved, the (possibly-revised) award is re-routed through a fresh awarding
// committee approval; on approval the affected contract regenerates and the
// vendor re-accepts — same forward flow, for revise AND uphold.
// ============================================================
async function resolveClarification(req, res, mode) {
  try {
    const arcId = Number(req.params.arcId);
    const clarificationId = Number(req.params.clarificationId);
    const userId = req.user?.id;
    const response = req.body?.response ? String(req.body.response) : null;
    if (mode === 'uphold' && !response) {
      return bad(res, 400, 'A response is required when upholding the original term');
    }

    const result = await db.tx(async (t) => {
      const cl = await arcContractClarificationModel.getById(clarificationId, t);
      if (!cl || Number(cl.arc_id) !== arcId) return bad(res, 404, 'Clarification not found', 2);
      if (cl.status !== 'open') return bad(res, 409, `Clarification already ${cl.status}`);
      const comm = await arcEvalModel.getCommEval(arcId, t);
      if (!comm) return bad(res, 400, 'Commercial evaluation has not been started');

      let oldValue = cl.old_value ?? null;
      let newValue = oldValue;
      if (mode === 'revise') {
        if (req.body?.value === undefined || req.body?.value === null || req.body?.value === '') {
          return bad(res, 400, 'A revised value is required');
        }
        // Scoped to THIS vendor × item only — never touches any other award.
        const applied = await arcEvalModel.updateAwardField(
          comm.id, Number(cl.arc_item_id), Number(cl.vendor_id), cl.field, req.body.value, t
        );
        oldValue = applied.old_value;
        newValue = applied.new_value;
      }
      const updated = await arcContractClarificationModel.resolve(clarificationId, {
        status: mode === 'revise' ? 'revised' : 'upheld',
        buyer_response: response,
        old_value: oldValue,
        new_value: newValue,
        resolved_by: userId,
      }, t);
      await arcEvalModel.appendCommEvalHistory(
        comm.id, `clarification_${mode}`,
        { clarification_id: clarificationId, field: cl.field, old_value: oldValue, new_value: newValue }, userId, t);
      await logArcEvent({
        arcId,
        eventType: mode === 'revise' ? ARC_EVENT_TYPES.CLARIFICATION_REVISED : ARC_EVENT_TYPES.CLARIFICATION_UPHELD,
        actorId: userId,
        payload: { clarification_id: clarificationId, field: cl.field, old_value: oldValue, new_value: newValue },
        txContext: t,
      });

      // Once every dispute on the ARC is settled, re-route the award through a
      // fresh committee approval (awarding) — same forward flow that ends at
      // vendor acceptance. No effect on commercial allocation.
      const remainingOpen = await arcContractClarificationModel.countOpenForArc(arcId, t);
      let reapprove = null;
      if (remainingOpen === 0) {
        const arc = await arcModel.getById(arcId, t);
        const policy = await resolveArcPolicy('ARC_COMMITTEE', {
          hospitality_company_id: arc.hospitality_company_id,
          hotel_id:               arc.hotel_id,
          department_id:          arc.department_id,
          process_id:             arc.process_id,
        }, t);
        if (!policy) {
          const err = new Error('No approval policy configured for the ARC committee in this scope.');
          err.httpStatus = 400; throw err;
        }
        const engineResult = await createApprovalInstance({
          entity_type:            'ARC_COMMITTEE',
          entity_id:              arcId,
          hospitality_company_id: arc.hospitality_company_id,
          hotel_id:               arc.hotel_id,
          department_id:          arc.department_id,
          process_id:             arc.process_id,
          approval_policy_id:     policy.id,
          initiated_by:           userId,
          metadata:               { reason: 'vendor_clarification', via: 'clarification_reapproval' },
          txContext:              t,
        });
        const instanceRow = engineResult?.instance || engineResult;
        if (!instanceRow?.id) throw new Error('Approval engine did not return an instance id');
        await arcEvalModel.setCommEvalStatus(comm.id, 'finalized', { approval_instance_id: instanceRow.id }, t);
        await arcModel.setStatus(arcId, 'committee_review', {}, t);
        await logArcEvent({
          arcId, eventType: ARC_EVENT_TYPES.CONTRACT_REISSUED,
          actorId: userId,
          payload: { reason: 'vendor_clarification', approval_instance_id: instanceRow.id }, txContext: t,
        });
        reapprove = { instanceId: instanceRow.id, autoApproved: engineResult.autoApproved === true };
      }
      return { __data: { clarification: updated, open_remaining: remainingOpen }, __reapprove: reapprove, __vendorId: cl.vendor_id };
    });
    if (result && result.__data) {
      // Auto-approved committee (initiator is the configured approver): fire the
      // post-approval effects (regenerate the affected contract) AFTER commit.
      if (result.__reapprove?.autoApproved) {
        await dispatchPostApprovalAction(result.__reapprove.instanceId, userId, {
          status: 'APPROVED', comment: 'Auto-approved — clarification re-award',
        });
      }
      // Notify the event vendor (clarification revised/upheld) — BOTH email
      // Per spec edge-case §9: when both clarification_revised and contract_reissued
      // fire in the same handler, suppress contract_reissued to avoid double-notifying.
      const clarifyEvent = mode === 'revise' ? ARC_EVENT_TYPES.CLARIFICATION_REVISED : ARC_EVENT_TYPES.CLARIFICATION_UPHELD;
      await notifyArcEvent({ arcId, eventType: clarifyEvent, actorId: userId, payload: { vendorId: result.__vendorId } });
      // Only fire contract_reissued separately when it fires independently (not here)
      return ok(res, result.__data, mode === 'revise' ? 'Term revised' : 'Original term upheld');
    }
    return result;
  } catch (err) {
    return fail(res, err, `[evalController.${mode}Clarification]`);
  }
}

export function reviseClarification(req, res) { return resolveClarification(req, res, 'revise'); }
export function upholdClarification(req, res) { return resolveClarification(req, res, 'uphold'); }

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
    // Notify comm evaluators + creator (BOTH email); tech evaluators in-app only — post-commit
    await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_APPROVED, actorId: approverUserId, payload: {} });
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
    // Notify tech evaluators + creator (BOTH email) post-commit
    await notifyArcEvent({ arcId, eventType: ARC_EVENT_TYPES.TECH_EVAL_REJECTED, actorId: approverUserId, payload: {} });
  } catch (err) {
    logger.error({ err, approvalInstanceId }, '[evalController.handleArcTechRejection]');
  }
}
