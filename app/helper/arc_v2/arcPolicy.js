// ARC v2 — which approval POLICY governs a rate contract's approval.
//
// Two families of ARC approval workflow, and they never mix:
//
//   single-hotel ARC → 'ARC' (publish + default for every stage), optionally
//                      overridden per stage by ARC_TECH / ARC_NEGOTIATION /
//                      ARC_COMMITTEE / ARC_AMENDMENT
//   group ARC        → 'ARC_GROUP', optionally overridden by ARC_GROUP_TECH /
//                      ARC_GROUP_NEGOTIATION / ARC_GROUP_COMMITTEE /
//                      ARC_GROUP_AMENDMENT — usually company-wide (hotel_id NULL)
//
// A group rate contract is approved by one group committee (Group ARC PRD §9),
// so it must never borrow a single hotel's workflow, and a single-hotel ARC
// must never pick up the group one.
//
// These are POLICY entity types only. Approval INSTANCES keep their existing
// types (ARC_PUBLISH, ARC_TECH, ARC_NEGOTIATION, ARC_COMMITTEE, ARC_AMENDMENT)
// because the pending-approval joins, post-approval hooks, notification links
// and nav badges all key on those, and propagation finds instances by policy
// id, so a separate policy row is already fully isolated.
//
// Scope is the ARC's LEAD hotel (tbl_arc.hotel_id): findBestMatchingPolicyTx
// matches `hotel_id = lead OR hotel_id IS NULL`, so a company-wide group
// workflow resolves for any lead hotel.
//
// This replaces three private copies of the same fallback chain
// (arcEvaluationController, arcNegotiationController, arcAmendmentController)
// and the publish endpoint's direct lookup.

import { findBestMatchingPolicyTx } from '../../models/generalModel.js';

export const ARC_POLICY_STAGES = Object.freeze([
  'ARC', 'ARC_TECH', 'ARC_NEGOTIATION', 'ARC_COMMITTEE', 'ARC_AMENDMENT',
]);

export const GROUP_POLICY_TYPE = Object.freeze({
  ARC: 'ARC_GROUP',
  ARC_TECH: 'ARC_GROUP_TECH',
  ARC_NEGOTIATION: 'ARC_GROUP_NEGOTIATION',
  ARC_COMMITTEE: 'ARC_GROUP_COMMITTEE',
  ARC_AMENDMENT: 'ARC_GROUP_AMENDMENT',
});

/**
 * @param {{ is_group, hospitality_company_id, hotel_id, department_id, process_id }} arc
 * @param {'ARC'|'ARC_TECH'|'ARC_NEGOTIATION'|'ARC_COMMITTEE'|'ARC_AMENDMENT'} stage
 * @param {*} t — transaction/runner
 * @returns {Promise<object|null>} the policy row, or null when none is configured
 */
export async function resolveArcPolicyFor(arc, stage, t) {
  if (!ARC_POLICY_STAGES.includes(stage)) {
    throw new Error(`resolveArcPolicyFor: unknown ARC approval stage '${stage}'`);
  }
  const scope = {
    hospitality_company_id: arc.hospitality_company_id,
    hotel_id: arc.hotel_id,
    department_id: arc.department_id,
    process_id: arc.process_id,
  };
  const [stageType, baseType] = arc.is_group
    ? [GROUP_POLICY_TYPE[stage], GROUP_POLICY_TYPE.ARC]
    : [stage, 'ARC'];
  let policy = await findBestMatchingPolicyTx({ entity_type: stageType, ...scope }, t);
  if (!policy && stageType !== baseType) {
    policy = await findBestMatchingPolicyTx({ entity_type: baseType, ...scope }, t);
  }
  return policy;
}

/**
 * The 400 raised when no workflow resolves. A single-hotel ARC keeps the
 * caller's existing message; a group ARC names the workflow the admin has to
 * set up, because "in this scope" does not tell them where to look.
 */
export function noArcPolicyError(arc, singleMessage, stageLabel) {
  const message = arc?.is_group
    ? `No approval workflow is set up for group rate contracts (${stageLabel}). Ask your administrator to configure the Group ARC workflow under Settings → Approvals, then try again.`
    : singleMessage;
  const err = new Error(message);
  err.httpStatus = 400;
  return err;
}

export default { ARC_POLICY_STAGES, GROUP_POLICY_TYPE, resolveArcPolicyFor, noArcPolicyError };
