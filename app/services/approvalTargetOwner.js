// Which company owns what an approval instance's handlers act on.
//
// An approval instance carries its company (hospitality_company_id) and names a
// TARGET: the RFQ it publishes, the round it activates, the ARC it floats, the
// MR it releases. Every post-approval and rejection handler acts on the target
// it reads from entity_id and metadata. Until the generic submit route was
// closed (c3a51cd6) any caller could open an instance of any type in their own
// company naming another company's target; its own approver could then decide
// it, and the handler acted on the other company.
//
// instanceTargetCompany resolves the target's company per engine type, in one
// SQL statement (TARGET_COMPANY_SQL). Every dispatch of a handler checks it
// first (approvalActionService.dispatchPostApprovalAction, and
// executeApprovalAction before it records the vote): a target that is missing,
// that names more than one company, or whose company is not the instance's
// runs no handler and sends no notification.
//
// The same CTEs (TARGET_COMPANY_CTES) are the pre-deploy gate in
// docs/releases/2026-10-inventory/sec1-predeploy-checks.sql; a test holds the
// two to the same text.
//
// Targets, per type. Every named target must resolve, and all to one company:
//   RFQ, TENDER      entity_id is the RFQ.
//   TECHNICAL        entity_id is the tech-eval round (→ its evaluation → RFQ);
//                    metadata.tech_evaluation_id and metadata.rfq_id, when set.
//   NEGOTIATION      the round metadata.round_id, else entity_id (an RFQ round);
//                    metadata.rfq_id and metadata.rfq_product_id, when set.
//   NEGOTIATION_QUOTE the product metadata.rfq_product_id, else entity_id;
//                    metadata.rfq_id, when set.
//   MR               entity_id is the material requisition.
//   PO               entity_id is the PO (→ its RFQ, else its ARC contract's
//                    ARC, else its source MR).
//   ARC_TECH, ARC_COMMITTEE, ARC_PUBLISH   entity_id is the ARC.
//   ARC_AMENDMENT    entity_id is the amendment (→ contract → ARC), and any
//                    amendment linked to this instance by approval_instance_id.
//   ARC_NEGOTIATION  metadata.round_id must equal entity_id, and that round must
//                    be an ARC round of metadata.arc_id; the ARC's company.
//   ARC (legacy)     metadata.rfq_id (entity_id is that RFQ or one of its
//                    products), else entity_id as the RFQ. No handler runs for
//                    it; resolved so the gate does not flag live rows.
//   anything else    no target (null).

import db from '../config/dbConn.js';
import { logger } from '../util/logger.js';
import { PoDecisionError } from './po/poDecisionError.js';

/**
 * The CTEs after `src(id, entity_type, entity_id, metadata)`. Ends with
 * `resolved(id, target_company)`. Shared, verbatim, with the pre-deploy gate.
 */
export const TARGET_COMPANY_CTES = `
ids AS (
  SELECT s.id, s.entity_type, s.entity_id::bigint AS entity_id,
         CASE WHEN s.metadata->>'rfq_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_id')::bigint END             AS m_rfq,
         CASE WHEN s.metadata->>'rfq_product_id'     ~ '^[0-9]{1,10}$' THEN (s.metadata->>'rfq_product_id')::bigint END     AS m_product,
         CASE WHEN s.metadata->>'round_id'           ~ '^[0-9]{1,10}$' THEN (s.metadata->>'round_id')::bigint END           AS m_round,
         CASE WHEN s.metadata->>'arc_id'             ~ '^[0-9]{1,10}$' THEN (s.metadata->>'arc_id')::bigint END             AS m_arc,
         CASE WHEN s.metadata->>'tech_evaluation_id' ~ '^[0-9]{1,10}$' THEN (s.metadata->>'tech_evaluation_id')::bigint END AS m_te,
         COALESCE(s.metadata->>'rfq_id', '')             <> '' AS has_rfq,
         COALESCE(s.metadata->>'rfq_product_id', '')     <> '' AS has_product,
         COALESCE(s.metadata->>'round_id', '')           <> '' AS has_round,
         COALESCE(s.metadata->>'tech_evaluation_id', '') <> '' AS has_te
    FROM src s
),
named AS (
  SELECT i.id,
         CASE
           WHEN i.entity_type IN ('RFQ', 'TENDER') THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
           WHEN i.entity_type = 'TECHNICAL' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_tech_evaluation_rounds tr
                JOIN tbl_rfq_product_tech_evaluation te ON te.id = tr.tbl_rfq_product_tech_evaluation_id
                JOIN tbl_rfq r ON r.id = te.rfq_id
               WHERE tr.id = i.entity_id)]
             || CASE WHEN i.has_te THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_product_tech_evaluation te JOIN tbl_rfq r ON r.id = te.rfq_id
                    WHERE te.id = i.m_te)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_rfq r ON r.id = nr.rfq_id
               WHERE nr.id = CASE WHEN i.has_round THEN i.m_round ELSE i.entity_id END
                 AND COALESCE(nr.source_type, 'RFQ') = 'RFQ')]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
             || CASE WHEN i.has_product THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint
                     FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
                    WHERE rp.id = i.m_product)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'NEGOTIATION_QUOTE' THEN ARRAY[
             (SELECT r.hospitality_company_id::bigint
                FROM tbl_rfq_products rp JOIN tbl_rfq r ON r.id = rp.rfq_id
               WHERE rp.id = CASE WHEN i.has_product THEN i.m_product ELSE i.entity_id END)]
             || CASE WHEN i.has_rfq THEN ARRAY[
                  (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.m_rfq)] ELSE '{}'::bigint[] END
           WHEN i.entity_type = 'MR' THEN ARRAY[
             (SELECT mr.hospitality_company_id::bigint FROM tbl_material_requisition mr WHERE mr.id = i.entity_id)]
           WHEN i.entity_type = 'PO' THEN ARRAY[
             (SELECT COALESCE(r.hospitality_company_id, a.hospitality_company_id, mr.hospitality_company_id)::bigint
                FROM tbl_rfq_purchase_order po
                LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
                LEFT JOIN tbl_arc_contract c ON c.id = po.arc_contract_id
                LEFT JOIN tbl_arc a ON a.id = c.arc_id
                LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
               WHERE po.id = i.entity_id)]
           WHEN i.entity_type IN ('ARC_TECH', 'ARC_COMMITTEE', 'ARC_PUBLISH') THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint FROM tbl_arc a WHERE a.id = i.entity_id)]
           WHEN i.entity_type = 'ARC_AMENDMENT' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_arc_amendment am
                JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                JOIN tbl_arc a ON a.id = c.arc_id
               WHERE am.id = i.entity_id)]
             || COALESCE((SELECT array_agg(a.hospitality_company_id::bigint)
                            FROM tbl_arc_amendment am
                            JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
                            JOIN tbl_arc a ON a.id = c.arc_id
                           WHERE am.approval_instance_id = i.id), '{}'::bigint[])
           WHEN i.entity_type = 'ARC_NEGOTIATION' THEN ARRAY[
             (SELECT a.hospitality_company_id::bigint
                FROM tbl_negotiation_rounds nr JOIN tbl_arc a ON a.id = nr.source_id
               WHERE nr.id = i.entity_id
                 AND i.m_round = i.entity_id
                 AND nr.source_type = 'ARC'
                 AND nr.source_id = i.m_arc)]
           WHEN i.entity_type = 'ARC' THEN
             CASE WHEN i.has_rfq THEN ARRAY[
                    (SELECT r.hospitality_company_id::bigint FROM tbl_rfq r
                      WHERE r.id = i.m_rfq
                        AND (i.entity_id = i.m_rfq
                             OR EXISTS (SELECT 1 FROM tbl_rfq_products rp
                                         WHERE rp.id = i.entity_id AND rp.rfq_id = i.m_rfq)))]
                  ELSE ARRAY[(SELECT r.hospitality_company_id::bigint FROM tbl_rfq r WHERE r.id = i.entity_id)]
             END
         END AS companies
    FROM ids i
),
resolved AS (
  SELECT n.id,
         CASE
           WHEN n.companies IS NULL OR cardinality(n.companies) = 0
                OR array_position(n.companies, NULL) IS NOT NULL THEN NULL
           WHEN (SELECT count(DISTINCT c) FROM unnest(n.companies) AS c) = 1 THEN n.companies[1]
         END AS target_company
    FROM named n
)`;

const TARGET_COMPANY_SQL = `
WITH src AS (
  SELECT $1::bigint AS id, $2::text AS entity_type, $3::bigint AS entity_id, $4::jsonb AS metadata
),${TARGET_COMPANY_CTES}
SELECT target_company FROM resolved`;

/**
 * The company that owns what this instance's handlers act on, or null when the
 * target is missing, ambiguous (names more than one company) or the type has
 * no known target.
 *
 * @param {object} dbCtx  db or a transaction
 * @param {object} instance  a tbl_approval_instances row
 * @returns {Promise<number|null>}
 */
export async function instanceTargetCompany(dbCtx, instance) {
  if (!instance?.id || !instance.entity_type || instance.entity_id == null) return null;
  const metadata = typeof instance.metadata === 'string'
    ? instance.metadata
    : JSON.stringify(instance.metadata || {});
  const row = await (dbCtx || db).oneOrNone(TARGET_COMPANY_SQL, [
    Number(instance.id), String(instance.entity_type), Number(instance.entity_id), metadata,
  ]);
  return row?.target_company == null ? null : Number(row.target_company);
}

/** Is the instance's target its own company's? */
export async function instanceTargetIsOwn(dbCtx, instance) {
  if (!instance || instance.hospitality_company_id == null) return false;
  const target = await instanceTargetCompany(dbCtx, instance);
  return target != null && target === Number(instance.hospitality_company_id);
}

/**
 * The check every handler dispatch makes. True means REFUSE: the target is not
 * the instance's company's, so no handler may run and nobody may be notified.
 * Logs the instance id and type only.
 */
export async function refusesForeignTarget(dbCtx, instance, surface) {
  if (await instanceTargetIsOwn(dbCtx, instance)) return false;
  logger.warn(
    { approval_instance_id: instance?.id ?? null, entity_type: instance?.entity_type ?? null, surface },
    '[approvalTarget] the instance\'s target is not its company\'s (or does not exist): no handler run, nothing notified'
  );
  return true;
}

/**
 * Thrown by executeApprovalAction for an instance whose target is not its
 * company's. Answers like a missing instance (404) and says nothing else; a
 * PoDecisionError so the routes that map those keep their status.
 */
export class ApprovalInstanceNotFoundError extends PoDecisionError {
  constructor() {
    super('Approval instance not found', { code: 'APPROVAL_INSTANCE_NOT_FOUND', httpStatus: 404 });
    this.name = 'ApprovalInstanceNotFoundError';
  }
}
