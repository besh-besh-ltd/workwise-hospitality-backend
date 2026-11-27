// ARC v2 listing — "Waiting on": who the next step of each rate contract is
// waiting on (REQ-2026-0094).
//
// The rate contract list card showed a status and, while floated, "N of M
// responses" — never who has to act next. The ARC page itself already names
// them (arcLifecycleModel.attachStageActors), but that runs ~20 queries per
// ARC, far too heavy for a listing. This computes the same answer for a whole
// page of rows in a handful of batched reads, read-only, ARC tables only.
//
// Who acts, by status (mirrors arcLifecycleModel.deriveStages):
//   draft / publish_rejected          → the creator
//   pending_publish_approval          → ARC_PUBLISH approvers at the current level
//   floated, window open              → invited vendors who have not responded
//   floated past its window /
//   submission_closed                 → technical evaluators (commercial when the
//                                       ARC has no technical clauses); the creator
//                                       when no quote came in
//   tech_eval_in_progress             → ARC_TECH approvers (technical evaluators
//                                       when no approval is pending, e.g. after a
//                                       send-back from commercial)
//   tech_eval_rejected                → technical evaluators
//   tech_eval_approved /
//   comm_eval_in_progress             → negotiation round approvers while a round
//                                       awaits approval, else commercial evaluators
//   committee_review                  → ARC_COMMITTEE approvers (commercial
//                                       evaluators when none is pending)
//   committee_sent_back               → commercial evaluators
//   committee_approved /
//   contract_generated                → commercial evaluators (send the copies)
//   awaiting_vendor_acceptance        → vendors yet to sign (commercial evaluators
//                                       while a vendor clarification is open)
//   active / expiring / ended         → nobody (null)
//
// Approver naming follows the rules the approval timelines use
// (components/dashboard/buyer/approval/approverState.js on the FE): a REMOVED
// approver is never named, and a deactivated account is left out of the names
// and counted in `unreachable` instead.
//
// Only names (and a vendor's company) leave the server — no ids, emails or
// phone numbers. The rows passed in are already RBAC-scoped by the listing.
//
// Vendor masking: before the commercial stage opens (bidding window and
// technical evaluation) a vendor is never named — only `VEN-<n>`, its place in
// the rate contract's invitation list. From the commercial stage on (after
// technical evaluation, or straight after bidding when there are no technical
// clauses) real names are shown, as everywhere else on the platform. Of the
// rows here, only "vendors yet to respond" fall before commercial; the
// technical stages name buyer-side evaluators/approvers, never vendors.
import db from '../config/dbConn.js';
import rbacModel from '../models/rbacModel.js';
import arcEvalModel from '../models/arc_v2/arcEvaluationModel.js';
import { windowClosed as windowClosedIst } from '../helper/arcTime.js';

const APPROVAL = {
  ARC_PUBLISH:     { role: 'Publish approval',           action: 'Approve publishing the rate contract to vendors' },
  ARC_TECH:        { role: 'Technical approval',         action: 'Approve the technical evaluation' },
  ARC_NEGOTIATION: { role: 'Negotiation round approval', action: 'Approve the negotiation round' },
  ARC_COMMITTEE:   { role: 'Committee approval',         action: 'Approve the awards' },
};

const TECH_EVAL = ['arc-tech', 'evaluate'];
const COMM_EVAL = ['arc-comm', 'evaluate'];

/** True once the submission window is over (status or IST clock). */
export function submissionWindowClosed(row) {
  if (!row) return false;
  if (row.status === 'submission_closed') return true;
  if (row.status === 'floated') return windowClosedIst(row);
  return false;
}

function approvalWaitingOn(entityType, approval) {
  const meta = APPROVAL[entityType];
  if (!approval) {
    return { kind: 'approval', role: meta.role, action: meta.action, step: null, people: [], unreachable: 0 };
  }
  return {
    kind: 'approval',
    role: meta.role,
    action: meta.action,
    step: { level: approval.step_order, of: approval.total_steps, rule: approval.decision_rule },
    people: approval.people,
    unreachable: approval.unreachable,
  };
}

function evaluatorsWaitingOn(kind, people, action) {
  return {
    kind: 'evaluators',
    role: kind === 'tech' ? 'Technical evaluators' : 'Commercial evaluators',
    action,
    step: null,
    people: people || [],
    unreachable: 0,
  };
}

function creatorWaitingOn(row, action) {
  return {
    kind: 'creator',
    role: 'Creator',
    action,
    step: null,
    people: row.created_by_name ? [{ name: row.created_by_name }] : [],
    unreachable: 0,
  };
}

/**
 * Pure rule: one row + the facts gathered for it → its waiting_on (or null).
 *
 * facts = {
 *   windowClosed, hasTechClauses, clarificationsOpen,
 *   approvals: { ARC_PUBLISH?, ARC_TECH?, ARC_NEGOTIATION?, ARC_COMMITTEE? }
 *              (each present only when that approval is PENDING),
 *   vendorsToRespond: [{name, company}], vendorsToSign: [{name, company}],
 *   techEvaluators: [{name}], commEvaluators: [{name}],
 * }
 */
export function deriveWaitingOn(row, facts) {
  const f = facts || {};
  const approvals = f.approvals || {};
  const s = row.status;

  switch (s) {
    case 'draft':
      return creatorWaitingOn(row, row.is_manual ? 'Finish the manual entry' : 'Finish and publish the draft');
    case 'publish_rejected':
      return creatorWaitingOn(row, 'Revise and publish again (publishing was rejected)');
    case 'pending_publish_approval':
      return approvalWaitingOn('ARC_PUBLISH', approvals.ARC_PUBLISH);
    case 'floated':
    case 'submission_closed': {
      if (!f.windowClosed) {
        const vendors = f.vendorsToRespond || [];
        if (vendors.length === 0) {
          return {
            kind: 'window',
            role: 'Submission window',
            action: 'Every invited vendor has responded; evaluation starts when the window closes',
            step: null,
            people: [],
            unreachable: 0,
          };
        }
        return {
          kind: 'vendors',
          role: 'Vendors yet to respond',
          action: 'Submit a quote before the window closes',
          step: null,
          people: vendors,
          unreachable: 0,
        };
      }
      if (Number(row.submitted_count || 0) === 0) {
        return creatorWaitingOn(row, 'No quote was received: extend the submission window');
      }
      return f.hasTechClauses
        ? evaluatorsWaitingOn('tech', f.techEvaluators, 'Score the vendor responses and submit the technical evaluation')
        : evaluatorsWaitingOn('comm', f.commEvaluators, 'Allocate the awards and finalize');
    }
    case 'tech_eval_in_progress':
      return approvals.ARC_TECH
        ? approvalWaitingOn('ARC_TECH', approvals.ARC_TECH)
        : evaluatorsWaitingOn('tech', f.techEvaluators, 'Score the vendor responses and submit the technical evaluation');
    case 'tech_eval_rejected':
      return evaluatorsWaitingOn('tech', f.techEvaluators, 'Re-score and submit again (the technical approval was rejected)');
    case 'tech_eval_approved':
    case 'comm_eval_in_progress':
      return approvals.ARC_NEGOTIATION
        ? approvalWaitingOn('ARC_NEGOTIATION', approvals.ARC_NEGOTIATION)
        : evaluatorsWaitingOn('comm', f.commEvaluators, 'Allocate the awards and finalize');
    case 'comm_eval_finalized':
    case 'committee_review':
      return approvals.ARC_COMMITTEE
        ? approvalWaitingOn('ARC_COMMITTEE', approvals.ARC_COMMITTEE)
        : evaluatorsWaitingOn('comm', f.commEvaluators, 'Finalize the awards for the committee');
    case 'committee_sent_back':
      return evaluatorsWaitingOn('comm', f.commEvaluators, 'Revise the awards and finalize again (sent back by the committee)');
    case 'committee_approved':
    case 'contract_generated':
      return evaluatorsWaitingOn('comm', f.commEvaluators, 'Review the contract copies and send them to the vendors');
    case 'awaiting_vendor_acceptance': {
      if (Number(f.clarificationsOpen || 0) > 0) {
        return evaluatorsWaitingOn('comm', f.commEvaluators, 'Resolve the vendor clarification');
      }
      const vendors = f.vendorsToSign || [];
      if (vendors.length === 0) return null;
      return {
        kind: 'vendors',
        role: 'Vendors yet to sign',
        action: 'Sign the contract',
        step: null,
        people: vendors,
        unreachable: 0,
      };
    }
    default:
      return null;
  }
}

/** Current-level approvers of each ARC's latest PENDING approval, by type. */
async function loadPendingApprovals(runner, arcIds) {
  if (arcIds.length === 0) return new Map();
  const rows = await runner.any(
    `WITH latest AS (
       SELECT DISTINCT ON (ai.entity_type, ai.entity_id)
              ai.id, ai.entity_type, ai.entity_id::bigint AS arc_id, ai.status, ai.current_step
         FROM tbl_approval_instances ai
        WHERE ai.entity_type IN ('ARC_PUBLISH', 'ARC_TECH', 'ARC_COMMITTEE')
          AND ai.entity_id = ANY($1::int[])
        ORDER BY ai.entity_type, ai.entity_id, ai.created_at DESC, ai.id DESC
     ),
     latest_round AS (
       -- ARC_NEGOTIATION instances are keyed by ROUND id; reach the ARC
       -- through the round (same lookup as arcLifecycleModel.loadRoundInstance).
       SELECT DISTINCT ON (nr.source_id)
              ai.id, ai.entity_type, nr.source_id::bigint AS arc_id, ai.status, ai.current_step
         FROM tbl_approval_instances ai
         JOIN tbl_negotiation_rounds nr ON nr.id = ai.entity_id
        WHERE ai.entity_type = 'ARC_NEGOTIATION'
          AND nr.source_type = 'ARC'
          AND nr.source_id = ANY($1::int[])
        ORDER BY nr.source_id, ai.created_at DESC, ai.id DESC
     ),
     pending AS (
       SELECT * FROM latest WHERE status = 'PENDING'
       UNION ALL
       SELECT * FROM latest_round WHERE status = 'PENDING'
     )
     SELECT p.arc_id, p.entity_type,
            s.step_order, s.decision_rule,
            (SELECT COUNT(*)::int FROM tbl_approval_instance_steps x
              WHERE x.approval_instance_id = p.id) AS total_steps,
            sa.approver_user_id AS user_id, sa.status AS approver_status,
            u.name,
            (COALESCE(u.status, 0) = 1 AND COALESCE(u.is_deleted, 0) = 0) AS account_active
       FROM pending p
       JOIN tbl_approval_instance_steps s
         ON s.approval_instance_id = p.id AND s.step_order = p.current_step
       -- LEFT JOIN keeps the step when every approver on it is REMOVED.
       LEFT JOIN tbl_approval_step_approvers sa
              ON sa.approval_instance_step_id = s.id
             AND sa.status <> 'REMOVED'
       LEFT JOIN tbl_users u ON u.id = sa.approver_user_id
      ORDER BY p.arc_id, p.entity_type, sa.id`,
    [arcIds]
  );

  const byArc = new Map();
  for (const r of rows) {
    const arcId = Number(r.arc_id);
    if (!byArc.has(arcId)) byArc.set(arcId, {});
    const perType = byArc.get(arcId);
    if (!perType[r.entity_type]) {
      perType[r.entity_type] = {
        step_order: Number(r.step_order),
        total_steps: Number(r.total_steps),
        decision_rule: r.decision_rule === 'ALL' ? 'ALL' : r.decision_rule === 'ANY' ? 'ANY' : null,
        live: [],
      };
    }
    if (r.user_id !== null && r.user_id !== undefined) {
      perType[r.entity_type].live.push({
        user_id: Number(r.user_id),
        name: r.name,
        status: r.approver_status,
        account_active: r.account_active === true,
      });
    }
  }

  // Name the approvers still to act; on an ANY level that has nobody left
  // PENDING (should not happen on a live level) fall back to every live one.
  for (const perType of byArc.values()) {
    for (const key of Object.keys(perType)) {
      const a = perType[key];
      const pending = a.live.filter((p) => p.status === 'PENDING');
      const base = pending.length > 0 ? pending : a.live;
      const seen = new Set();
      const reachable = [];
      let unreachable = 0;
      for (const p of base) {
        if (seen.has(p.user_id)) continue;
        seen.add(p.user_id);
        if (!p.account_active) { unreachable += 1; continue; }
        if (p.name) reachable.push({ name: p.name });
      }
      perType[key] = {
        step_order: a.step_order,
        total_steps: a.total_steps,
        decision_rule: a.decision_rule,
        people: reachable,
        unreachable,
      };
    }
  }
  return byArc;
}

/**
 * Vendors still to respond (open window) and still to sign (awaiting acceptance).
 *
 * Vendor identity is masked until the commercial stage opens: the open window
 * is before technical evaluation, so a vendor yet to respond is shown as a code,
 * never its name or company. The code is `VEN-<n>`, n being the vendor's place
 * in that rate contract's invitation list (stable for the contract, never
 * derived from the name or user id). Vendors yet to sign come after award —
 * the commercial stage has revealed them — so they keep their names.
 */
async function loadPendingVendors(runner, respondIds, signIds) {
  const out = { respond: new Map(), sign: new Map() };
  if (respondIds.length === 0 && signIds.length === 0) return out;
  const rows = await runner.any(
    `SELECT 'respond' AS src, x.arc_id, ('VEN-' || x.pos) AS name, NULL::text AS company, x.pos AS ord
       FROM (
         SELECT i.arc_id::bigint AS arc_id, i.status,
                ROW_NUMBER() OVER (PARTITION BY i.arc_id ORDER BY i.id) AS pos
           FROM tbl_arc_invitation i
          WHERE i.arc_id = ANY($1::int[])
       ) x
      WHERE x.status IN ('invited', 'viewed')
     UNION ALL
     SELECT 'sign' AS src, c.arc_id::bigint AS arc_id, uv.name,
            COALESCE(tc.company_name, uv.organization_name) AS company, 0 AS ord
       FROM tbl_arc_contract c
       JOIN tbl_users uv ON uv.id = c.vendor_id
       LEFT JOIN tbl_company tc ON tc.id = uv.company_id
      WHERE c.arc_id = ANY($2::int[])
        AND c.status = 'awaiting_acceptance'
      ORDER BY 1, 2, 5, 3`,
    [respondIds, signIds]
  );
  for (const r of rows) {
    const m = out[r.src];
    const arcId = Number(r.arc_id);
    if (!m.has(arcId)) m.set(arcId, []);
    m.get(arcId).push(r.src === 'respond'
      ? { name: r.name }
      : { name: r.name, company: r.company || null });
  }
  return out;
}

/** process_id + open vendor clarifications per ARC (the list row carries neither). */
async function loadRowFacts(runner, arcIds) {
  if (arcIds.length === 0) return new Map();
  const rows = await runner.any(
    `SELECT a.id, a.process_id,
            (SELECT COUNT(*)::int FROM tbl_arc_contract_clarification cc
              WHERE cc.arc_id = a.id AND cc.status = 'open') AS clarifications_open
       FROM tbl_arc a
      WHERE a.id = ANY($1::int[])`,
    [arcIds]
  );
  return new Map(rows.map((r) => [Number(r.id), r]));
}

function evaluatorKey(perm, row, processId) {
  return `${perm[0]}:${row.hotel_id}:${row.department_id ?? ''}:${processId ?? ''}`;
}

/** Statuses whose answer needs the technical / commercial evaluator roster. */
function evaluatorNeeds(row, windowClosed, hasTech, approvals, clarificationsOpen) {
  const s = row.status;
  const needs = { tech: false, comm: false };
  if ((s === 'floated' || s === 'submission_closed') && windowClosed && Number(row.submitted_count || 0) > 0) {
    if (hasTech) needs.tech = true; else needs.comm = true;
  }
  if (s === 'tech_eval_rejected') needs.tech = true;
  if (s === 'tech_eval_in_progress' && !approvals.ARC_TECH) needs.tech = true;
  if ((s === 'tech_eval_approved' || s === 'comm_eval_in_progress') && !approvals.ARC_NEGOTIATION) needs.comm = true;
  if ((s === 'comm_eval_finalized' || s === 'committee_review') && !approvals.ARC_COMMITTEE) needs.comm = true;
  if (['committee_sent_back', 'committee_approved', 'contract_generated'].includes(s)) needs.comm = true;
  if (s === 'awaiting_vendor_acceptance' && Number(clarificationsOpen || 0) > 0) needs.comm = true;
  return needs;
}

/**
 * Stamp `waiting_on` and `submission_window_closed` on each listing row, in
 * place. Read-only. Meant for one page of rows (the listing paginates first).
 */
export async function attachWaitingOn(rows, { txContext = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const runner = txContext || db;
  const ids = rows.map((r) => Number(r.id)).filter(Number.isFinite);

  const closed = new Map(rows.map((r) => [Number(r.id), submissionWindowClosed(r)]));
  const respondIds = rows
    .filter((r) => (r.status === 'floated' || r.status === 'submission_closed') && !closed.get(Number(r.id)))
    .map((r) => Number(r.id));
  const signIds = rows.filter((r) => r.status === 'awaiting_vendor_acceptance').map((r) => Number(r.id));

  const [approvalsByArc, vendors, factsById] = await Promise.all([
    loadPendingApprovals(runner, ids),
    loadPendingVendors(runner, respondIds, signIds),
    loadRowFacts(runner, ids),
  ]);

  // Technical clauses matter only once a window has closed with quotes in.
  // Same single source of truth the lifecycle uses (item OR universal clauses).
  const hasTech = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    if ((r.status === 'floated' || r.status === 'submission_closed') && closed.get(id) && Number(r.submitted_count || 0) > 0) {
      hasTech.set(id, await arcEvalModel.arcHasTechClauses(id, runner));
    }
  }

  // Evaluator rosters, one batched read for every distinct hotel × department
  // × process × permission on the page.
  const specs = new Map();
  const needsById = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    const approvals = approvalsByArc.get(id) || {};
    const needs = evaluatorNeeds(r, closed.get(id), hasTech.get(id), approvals, factsById.get(id)?.clarifications_open);
    needsById.set(id, needs);
    if (!r.hotel_id) continue;
    const processId = factsById.get(id)?.process_id ?? null;
    for (const [flag, perm] of [['tech', TECH_EVAL], ['comm', COMM_EVAL]]) {
      if (!needs[flag]) continue;
      const key = evaluatorKey(perm, r, processId);
      if (!specs.has(key)) {
        specs.set(key, {
          key,
          hotelIds: [Number(r.hotel_id)],
          resource: perm[0],
          actions: [perm[1]],
          departmentId: r.department_id ?? null,
          processId,
        });
      }
    }
  }
  const rosters = specs.size > 0
    ? await rbacModel.getUsersWithModuleActionsBatch([...specs.values()])
    : new Map();
  const rosterFor = (perm, r, processId) =>
    (rosters.get(evaluatorKey(perm, r, processId)) || []).map((u) => ({ name: u.name }));

  for (const r of rows) {
    const id = Number(r.id);
    const processId = factsById.get(id)?.process_id ?? null;
    const needs = needsById.get(id);
    r.submission_window_closed = closed.get(id) === true;
    r.waiting_on = deriveWaitingOn(r, {
      windowClosed: closed.get(id),
      hasTechClauses: hasTech.get(id) === true,
      clarificationsOpen: factsById.get(id)?.clarifications_open || 0,
      approvals: approvalsByArc.get(id) || {},
      vendorsToRespond: vendors.respond.get(id) || [],
      vendorsToSign: vendors.sign.get(id) || [],
      techEvaluators: needs.tech ? rosterFor(TECH_EVAL, r, processId) : [],
      commEvaluators: needs.comm ? rosterFor(COMM_EVAL, r, processId) : [],
    });
  }
  return rows;
}

export default { attachWaitingOn, deriveWaitingOn, submissionWindowClosed };
