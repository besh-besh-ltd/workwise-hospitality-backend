import db from '../../config/dbConn.js';
import arcModel from './arcModel.js';
import { logArcEvent, ARC_EVENT_TYPES } from '../../services/arcEventLogService.js';

/**
 * ARC v2 — Lifecycle stage state machine.
 *
 * The single authoritative buyer page renders five stages:
 *   overview → technical → commercial → awarding → active
 * Each stage gets one of: locked | active | partial | complete | skipped | ended.
 *
 * The rules live HERE (not the controller) because three consumers share
 * them: the GET /:id/lifecycle endpoint, the immutability guards inside the
 * evaluation write endpoints, and the integration tests that pin the state
 * machine. Lifecycle invariants:
 *   - a `partial` stage unlocks the next stage but stays editable;
 *   - a `complete` stage is immutable (assertStageWritable throws 409);
 *   - `skipped` (technical with zero clauses) behaves like complete for
 *     unlocking but stays writable until commercial completes — configuring
 *     clauses late simply un-skips it.
 *
 * There is no scheduler for floated → submission_closed; the computation is
 * date-driven and the GET endpoint may lazily flip the status (lazyFlip).
 */

export const STAGE_ORDER = ['overview', 'technical', 'commercial', 'awarding', 'active'];
const STAGE_LABEL = {
  overview:   'Overview',
  technical:  'Technical Evaluation',
  commercial: 'Commercial',
  awarding:   'Awarding',
  active:     'Contract Active',
};

const ENDED_STATUSES  = ['expired', 'terminated', 'closed_no_award'];
const ACTIVE_STATUSES = ['contract_generated', 'awaiting_vendor_acceptance', 'contract_active', 'expiring_soon'];

function stageImmutableError(stageKey) {
  const err = new Error(`Stage '${stageKey}' is complete and immutable`);
  err.httpStatus = 409;
  err.code = 'STAGE_IMMUTABLE';
  return err;
}

function stageLockedError(stageKey) {
  const err = new Error(`Stage '${stageKey}' is not open yet — complete the preceding stage first`);
  err.httpStatus = 409;
  err.code = 'STAGE_LOCKED';
  return err;
}

/** Latest approval instance of a type for an ARC, with caller's actability. */
async function loadInstance(runner, entityType, arcId, userId) {
  const instance = await runner.oneOrNone(
    `SELECT id, status, current_step, created_at, completed_at
       FROM tbl_approval_instances
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [entityType, arcId]
  );
  if (!instance) return null;
  let canUserApprove = false;
  if (userId && instance.status === 'PENDING') {
    const hit = await runner.oneOrNone(
      `SELECT 1
         FROM tbl_approval_instance_steps s
         JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
        WHERE s.approval_instance_id = $1
          AND s.step_order = $2
          AND sa.approver_user_id = $3
          AND sa.status = 'PENDING'
        LIMIT 1`,
      [instance.id, instance.current_step, userId]
    );
    canUserApprove = !!hit;
  }
  return {
    instance_id: Number(instance.id),
    status: instance.status,
    current_step: instance.current_step,
    created_at: instance.created_at,
    completed_at: instance.completed_at,
    can_user_approve: canUserApprove,
  };
}

/** All the facts the state rules need, in a handful of queries. */
async function gatherFacts(runner, arc, userId) {
  const arcId = arc.id;

  const invites = await runner.one(
    `SELECT COUNT(*)::int AS invited,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
       FROM tbl_arc_invitation WHERE arc_id = $1`,
    [arcId]
  );
  const submitted = await runner.one(
    `SELECT COUNT(*)::int AS n FROM tbl_arc_quote
      WHERE arc_id = $1 AND submitted_at IS NOT NULL AND withdrawn_at IS NULL`,
    [arcId]
  );

  const tech = await runner.one(
    `SELECT COUNT(DISTINCT i.id)::int AS items_total,
            COUNT(DISTINCT te.arc_item_id) FILTER (WHERE c.id IS NOT NULL)::int AS items_with_clauses,
            COUNT(c.id)::int AS clauses_total
       FROM tbl_arc_item i
       LEFT JOIN tbl_arc_item_tech_evaluation te ON te.arc_item_id = i.id
       LEFT JOIN tbl_arc_item_tech_evaluation_clauses c ON c.arc_item_tech_evaluation_id = te.id
      WHERE i.arc_id = $1`,
    [arcId]
  );

  // A vendor is "fully scored" when they hold a buyer-marked response for
  // EVERY clause across the whole ARC, AND every MANDATORY clause additionally
  // carries a non-null mandatory_passed verdict (a half-judged mandatory clause
  // must NOT make the stage look ready — two-envelope mandatory gate).
  const scoring = await runner.one(
    `WITH arc_clauses AS (
       SELECT c.id, c.is_mandatory
         FROM tbl_arc_item_tech_evaluation_clauses c
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE i.arc_id = $1
     ),
     per_vendor AS (
       SELECT r.vendor_id,
              COUNT(*) FILTER (WHERE r.buyer_marks IS NOT NULL)::int AS scored,
              -- mandatory clauses still awaiting a pass/fail verdict
              COUNT(*) FILTER (WHERE c.is_mandatory = TRUE AND r.mandatory_passed IS NULL)::int AS mandatory_unjudged
         FROM tbl_arc_item_tech_evaluation_vendors_response r
         JOIN arc_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
        GROUP BY r.vendor_id
     )
     SELECT (SELECT COUNT(*)::int FROM arc_clauses) AS clauses_total,
            COUNT(*)::int AS vendors_in_play,
            COUNT(*) FILTER (WHERE scored = (SELECT COUNT(*) FROM arc_clauses)
                               AND mandatory_unjudged = 0
                               AND (SELECT COUNT(*) FROM arc_clauses) > 0)::int AS vendors_fully_scored
       FROM per_vendor`,
    [arcId]
  );

  const cleared = await runner.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE cv.status = 'qualified')::int AS qualified
       FROM tbl_arc_item_tech_evaluation_cleared_vendors cv
       JOIN tbl_arc_item_tech_evaluation te ON te.id = cv.arc_item_tech_evaluation_id
       JOIN tbl_arc_item i ON i.id = te.arc_item_id
      WHERE i.arc_id = $1`,
    [arcId]
  );

  const comm = await runner.oneOrNone(
    `SELECT * FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [arcId]
  );
  const allocated = comm
    ? await runner.one(
        `SELECT COUNT(DISTINCT arc_item_id)::int AS items_allocated
           FROM tbl_arc_comm_evaluation_award WHERE arc_comm_evaluation_id = $1`,
        [comm.id]
      )
    : { items_allocated: 0 };

  const contracts = await runner.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('active','expiring_soon','expired'))::int AS accepted
       FROM tbl_arc_contract WHERE arc_id = $1`,
    [arcId]
  );

  // Open vendor clarifications keep the (locked) commercial stage flagged so
  // the buyer is routed to resolve them; absent table → 0 (defensive).
  const clarificationsOpen = await runner.oneOrNone(
    `SELECT COUNT(*)::int AS c FROM tbl_arc_contract_clarification
      WHERE arc_id = $1 AND status = 'open'`,
    [arcId]
  ).then((r) => (r ? r.c : 0)).catch(() => 0);

  const [techApproval, committeeApproval, publishApproval] = await Promise.all([
    loadInstance(runner, 'ARC_TECH', arcId, userId),
    loadInstance(runner, 'ARC_COMMITTEE', arcId, userId),
    loadInstance(runner, 'ARC_PUBLISH', arcId, userId),
  ]);

  return {
    invited: invites.invited,
    declined: invites.declined,
    submitted: submitted.n,
    items_total: tech.items_total,
    items_with_clauses: tech.items_with_clauses,
    clauses_total: tech.clauses_total,
    vendors_in_play: scoring.vendors_in_play,
    vendors_fully_scored: scoring.vendors_fully_scored,
    cleared_total: cleared.total,
    qualified_vendors: cleared.qualified,
    comm,
    items_allocated: allocated.items_allocated,
    contracts_total: contracts.total,
    contracts_accepted: contracts.accepted,
    clarifications_open: clarificationsOpen,
    techApproval,
    committeeApproval,
    publishApproval,
  };
}

/** Pure rules — facts in, stages out. Exported for unit-level reuse. */
export function deriveStages(arc, f) {
  // Pre-float, not-yet-live statuses behave like draft for the window: the ARC
  // never floated, so the window is NOT closed and downstream stages stay locked.
  const PRE_FLOAT = ['draft', 'pending_publish_approval', 'publish_rejected'];
  const windowClosed =
    !([...PRE_FLOAT, 'floated'].includes(arc.status)) ||
    (arc.status === 'floated' && arc.submission_end_at && new Date(arc.submission_end_at) < new Date());

  // ── overview ──
  const overview = {
    key: 'overview', label: STAGE_LABEL.overview,
    state: windowClosed ? 'complete' : 'active',
    reason:
      arc.status === 'pending_publish_approval' ? 'pending_publish_approval'
      : arc.status === 'publish_rejected'        ? 'publish_rejected'
      : windowClosed ? 'window_closed'
      : (arc.status === 'draft' ? 'draft' : 'window_open'),
    counts: { invited: f.invited, submitted: f.submitted, declined: f.declined },
    window: {
      submission_start_at: arc.submission_start_at,
      submission_end_at: arc.submission_end_at,
      closed: windowClosed,
    },
    // Surface the publish-approval chain on the overview stage so the FE can
    // render the approver matrix + approve/reject for the current approver.
    publish_approval: f.publishApproval || null,
  };

  // ── technical ──
  let technical;
  const techCounts = {
    items_total: f.items_total,
    items_with_clauses: f.items_with_clauses,
    clauses_total: f.clauses_total,
    vendors_in_play: f.vendors_in_play,
    vendors_fully_scored: f.vendors_fully_scored,
    qualified_vendors: f.qualified_vendors,
  };
  if (!windowClosed) {
    technical = { state: 'locked', reason: 'window_open' };
  } else if (f.clauses_total === 0) {
    technical = { state: 'skipped', reason: 'no_clauses_configured' };
  } else if (f.techApproval?.status === 'APPROVED') {
    technical = { state: 'complete', reason: 'approved' };
  } else if (f.vendors_fully_scored >= 1) {
    technical = {
      state: 'partial',
      reason: f.techApproval?.status === 'PENDING' ? 'awaiting_approval'
        : arc.status === 'tech_eval_rejected' ? 'approval_rejected'
        : 'scoring_partial',
    };
  } else {
    technical = {
      state: 'active',
      reason: arc.status === 'tech_eval_rejected' ? 'approval_rejected' : 'scoring_in_progress',
    };
  }
  technical = {
    key: 'technical', label: STAGE_LABEL.technical,
    ...technical, counts: techCounts, approval: f.techApproval,
  };

  // ── commercial ──
  // Commercial opens ONLY once technical is settled: APPROVED (complete) or
  // skipped (no clauses anywhere). Scoring alone — even all vendors on all
  // items — is provisional until the tech approval ratifies qualification,
  // so awarding against it would let unratified verdicts drive money.
  let commercial;
  const techUnlocksCommercial = ['complete', 'skipped'].includes(technical.state);
  if (!techUnlocksCommercial) {
    commercial = { state: 'locked', reason: 'technical_incomplete' };
  } else if (f.comm?.status === 'finalized') {
    commercial = { state: 'complete', reason: 'finalized' };
  } else if (f.items_total > 0 && f.items_allocated === f.items_total) {
    commercial = {
      state: 'partial',
      reason: f.comm?.status === 'sent_back' ? 'sent_back' : 'awaiting_finalize',
    };
  } else {
    commercial = {
      state: 'active',
      reason: f.comm
        ? (f.comm.status === 'sent_back' ? 'sent_back' : 'allocation_in_progress')
        : 'not_started',
    };
  }
  // A vendor clarification keeps commercial LOCKED (awarded means awarded) but
  // flags it: the evaluator resolves the disputed value here (revise/uphold),
  // it never re-opens the allocation matrix.
  if (f.clarifications_open > 0 && commercial.state === 'complete') {
    commercial.reason = 'clarification_pending';
  }
  commercial = {
    key: 'commercial', label: STAGE_LABEL.commercial,
    ...commercial,
    counts: { items_total: f.items_total, items_allocated: f.items_allocated },
    clarifications_open: f.clarifications_open,
    comm_evaluation: f.comm
      ? { id: Number(f.comm.id), status: f.comm.status, finalized_at: f.comm.finalized_at }
      : null,
  };

  // ── awarding ──
  let awarding;
  if (!['partial', 'complete'].includes(commercial.state)) {
    awarding = { state: 'locked', reason: 'commercial_incomplete' };
  } else if (f.committeeApproval?.status === 'APPROVED') {
    awarding = { state: 'complete', reason: 'contracts_generated' };
  } else if (f.committeeApproval?.status === 'PENDING') {
    awarding = { state: 'active', reason: 'committee_in_review' };
  } else {
    // Commercial partial/complete but no committee instance — read-only
    // preview of the proposed awards (instance spawns at finalize).
    awarding = { state: 'active', reason: 'preview' };
  }
  awarding = {
    key: 'awarding', label: STAGE_LABEL.awarding,
    ...awarding, approval: f.committeeApproval,
  };

  // ── active ──
  let active;
  if (ENDED_STATUSES.includes(arc.status)) {
    active = { state: 'ended', reason: arc.status };
  } else if (ACTIVE_STATUSES.includes(arc.status)) {
    active = {
      state: 'active',
      reason: arc.status === 'contract_active' || arc.status === 'expiring_soon'
        ? 'live'
        : 'awaiting_vendor_acceptance',
    };
  } else {
    active = { state: 'locked', reason: 'not_awarded' };
  }
  active = {
    key: 'active', label: STAGE_LABEL.active,
    ...active,
    counts: { contracts_total: f.contracts_total, contracts_accepted: f.contracts_accepted },
  };

  const stages = [overview, technical, commercial, awarding, active];

  // Default stage: last in order that is actionable / terminal for the user.
  // Awarding in 'preview' is read-only by definition — the actionable work
  // (finalize) still lives on Commercial, so preview never wins the default.
  let defaultStage = 'overview';
  for (const s of stages) {
    if (s.key === 'awarding' && s.reason === 'preview') continue;
    if (['active', 'partial', 'ended'].includes(s.state)) defaultStage = s.key;
  }
  // An open vendor clarification needs the evaluator on Commercial to resolve it.
  if (f.clarifications_open > 0) defaultStage = 'commercial';
  return { stages, default_stage: defaultStage };
}

const arcLifecycleModel = {
  STAGE_ORDER,

  /**
   * Full lifecycle computation. `lazyFlip` (GET endpoint only) flips
   * floated→submission_closed once the window has passed — idempotent,
   * event-logged, never run from write-path guards.
   */
  computeLifecycle: async (arcId, { userId = null, lazyFlip = false, txContext = null } = {}) => {
    const runner = txContext || db;
    let arc = await runner.oneOrNone(
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
    if (!arc) return null;

    if (
      lazyFlip &&
      arc.status === 'floated' &&
      arc.submission_end_at &&
      new Date(arc.submission_end_at) < new Date()
    ) {
      await arcModel.setStatus(arcId, 'submission_closed', {}, txContext);
      await logArcEvent({
        arcId,
        eventType: ARC_EVENT_TYPES.SUBMISSION_CLOSED,
        actorId: null,
        payload: { via: 'lifecycle_lazy_flip', submission_end_at: arc.submission_end_at },
        txContext,
      });
      arc = { ...arc, status: 'submission_closed' };
    }

    const facts = await gatherFacts(runner, arc, userId);
    const { stages, default_stage } = deriveStages(arc, facts);
    return {
      arc,
      current_status: arc.status,
      default_stage,
      stages,
      computed_at: new Date().toISOString(),
    };
  },

  /**
   * Immutability guard for write endpoints. Throws 409 STAGE_IMMUTABLE when
   * the named stage is complete. Never lazy-flips.
   */
  // blockLocked: also reject writes to a stage that hasn't OPENED yet (409
  // STAGE_LOCKED). Opt-in because setupTechEval legitimately asserts the
  // commercial stage isn't complete while commercial is still locked.
  assertStageWritable: async (arcId, stageKey, txContext = null, { blockLocked = false } = {}) => {
    const lifecycle = await arcLifecycleModel.computeLifecycle(arcId, { txContext });
    if (!lifecycle) {
      const err = new Error('ARC not found');
      err.httpStatus = 404;
      throw err;
    }
    const stage = lifecycle.stages.find((s) => s.key === stageKey);
    if (stage && stage.state === 'complete') throw stageImmutableError(stageKey);
    if (blockLocked && stage && stage.state === 'locked') throw stageLockedError(stageKey);
    return lifecycle;
  },

  // ── id resolvers for guards/middleware (response → clause → eval → item → arc) ──
  getArcIdForItem: async (itemId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT arc_id FROM tbl_arc_item WHERE id = $1`, [itemId]
    );
    return row ? Number(row.arc_id) : null;
  },

  getArcIdForResponse: async (responseId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT i.arc_id
         FROM tbl_arc_item_tech_evaluation_vendors_response r
         JOIN tbl_arc_item_tech_evaluation_clauses c ON c.id = r.arc_item_tech_evaluation_clauses_id
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE r.id = $1`,
      [responseId]
    );
    return row ? Number(row.arc_id) : null;
  },

  getArcIdForClause: async (clauseId, txContext = null) => {
    const row = await (txContext || db).oneOrNone(
      `SELECT i.arc_id
         FROM tbl_arc_item_tech_evaluation_clauses c
         JOIN tbl_arc_item_tech_evaluation te ON te.id = c.arc_item_tech_evaluation_id
         JOIN tbl_arc_item i ON i.id = te.arc_item_id
        WHERE c.id = $1`,
      [clauseId]
    );
    return row ? Number(row.arc_id) : null;
  },
};

export default arcLifecycleModel;
